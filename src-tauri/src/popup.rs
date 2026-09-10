// One selectable application in the popup blacklist/whitelist picker.
// `process` is the executable name -- the exact value the popup monitor
// compares against (case-insensitively) in `is_popup_enabled_for_current_process`.
// `title` is a visible window title, purely so the user can tell apart two
// processes that share an exe name.
#[derive(serde::Serialize, Clone)]
pub struct PopupApp {
    pub process: String,
    pub title: String,
}

#[cfg(target_os = "windows")]
mod win_impl {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Mutex;
    use std::thread;
    use std::time::{Duration, Instant};

    use log::{info, warn};
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, EnumWindows, GetCursorInfo, GetMessageW,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        LoadCursorW, MSLLHOOKSTRUCT, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, CURSORINFO, MSG, OCR_IBEAM, WH_MOUSE_LL, WM_QUIT,
    };

    use super::PopupApp;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, SendInput,
        VIRTUAL_KEY,
    };

    use crate::config::{get, set};
    use crate::process::get_foreground_process_name;
    use crate::window::popup_window;
    use tauri::Manager;

    static POPUP_RUNNING: AtomicBool = AtomicBool::new(false);
    static POPUP_PENDING: AtomicBool = AtomicBool::new(false);
    static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
    // Popup visibility cache: written on every show/hide (frontend emits
    // "popup_visible", Rust stores on its own hide calls), read by the hook
    // thread on every mouse move. Lets the hook short-circuit with zero
    // Tauri/WebView2 IPC when the popup is hidden. This fixes the first-move
    // jank: previously every mouse move did a synchronous is_visible() call
    // from the hook thread, and the first one had to warm up the IPC path.
    static POPUP_VISIBLE: AtomicBool = AtomicBool::new(false);

    // Ensures POPUP_PENDING is cleared when a selection attempt finishes,
    // even if handle_selection panics. Without this, a single failure would
    // stick POPUP_PENDING=true and permanently block every future popup
    // (the "popup only shows once then never again" bug).
    struct PendingGuard;
    impl Drop for PendingGuard {
        fn drop(&mut self) {
            POPUP_PENDING.store(false, Ordering::SeqCst);
        }
    }

    // Drag detection state (mouse down position + whether the cursor was a
    // text I-beam at press time). Requiring an I-beam at press time is what
    // distinguishes "text selection" from plain drags (dragging a file, a
    // window, or a screenshot/Cropper rubber-band rect): those start with an
    // arrow or cross cursorscreen and would otherwise be misread as a
    // selection, clobbering the app (e.g. QQ file-send, screenshot box).
    static DRAG_START: Mutex<Option<(i32, i32, bool)>> = Mutex::new(None);
    const MIN_DRAG_DISTANCE: f64 = 5.0;
    const MAX_DBLCLICK_INTERVAL: Duration = Duration::from_millis(500);
    const MAX_DBLCLICK_DISTANCE: f64 = 5.0;
    // Opacity / dismissal zones (px), measured from the nearest edge of the
    // popup rectangle to the mouse:
    //  - within VISIBLE_MARGIN:  opacity = 1.0 (fully visible)
    //  - beyond FADE_MARGIN:     opacity = 0.0 and the popup hides
    //  - in between:            opacity fades linearly 1.0 -> 0.0
    const POPUP_VISIBLE_MARGIN: i32 = 12;
    const POPUP_FADE_MARGIN: i32 = 140;

    // True when the system-wide cursor is the text I-beam (OCR_IBEAM).
    // GetCursorInfo returns the cursor currently captured globally, even when
    // the mouse is over another process' window (GetCursor alone would return
    // NULL there).
    fn cursor_is_ibeam() -> bool {
        unsafe {
            let beam = LoadCursorW(
                None,
                windows::core::PCWSTR(OCR_IBEAM.0 as usize as *const u16),
            )
            .unwrap_or_default();
            let mut ci = CURSORINFO {
                cbSize: std::mem::size_of::<CURSORINFO>() as u32,
                ..Default::default()
            };
            GetCursorInfo(&mut ci).is_ok() && ci.hCursor == beam
        }
    }

    unsafe extern "system" fn mouse_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            let wm = wparam.0 as u32;
            match wm {
                // WM_LBUTTONDOWN = 0x0201
                0x0201 => {
                    if let Some(hs) = (lparam.0 as *const MSLLHOOKSTRUCT).as_ref() {
                        let is_ibeam = cursor_is_ibeam();
                        *DRAG_START.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some((hs.pt.x, hs.pt.y, is_ibeam));
                    }
                }
                // WM_MOUSEMOVE = 0x0200
                0x0200 => {
                    let pos = (lparam.0 as *const MSLLHOOKSTRUCT)
                        .as_ref()
                        .map(|hs| (hs.pt.x, hs.pt.y))
                        .unwrap_or((0, 0));
                    // Continuously fade the popup as the mouse moves away, and
                    // hide it once fully transparent. Runs on the hook thread,
                    // which only touches window opacity/visibility (safe).
                    update_popup_opacity(pos.0, pos.1);
                }
                // WM_LBUTTONUP = 0x0202
                0x0202 => {
                    let release_pos = (lparam.0 as *const MSLLHOOKSTRUCT)
                        .as_ref()
                        .map(|hs| (hs.pt.x, hs.pt.y))
                        .unwrap_or((0, 0));

                    let (drag_dist, from_ibeam) = DRAG_START
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .map(|(sx, sy, beam)| {
                            let d =
                                ((release_pos.0 - sx).pow(2) + (release_pos.1 - sy).pow(2)) as f64;
                            (d.sqrt(), beam)
                        })
                        .unwrap_or((0.0, false));
                    *DRAG_START.lock().unwrap_or_else(|e| e.into_inner()) = None;

                    // Detect double click (two clicks within 500ms & 5px)
                    let now = Instant::now();
                    let mut last = LAST_CLICK.lock().unwrap_or_else(|e| e.into_inner());
                    let is_double = match *last {
                        Some((t, x, y)) => {
                            now.duration_since(t) < MAX_DBLCLICK_INTERVAL
                                && (((release_pos.0 - x).pow(2) + (release_pos.1 - y).pow(2))
                                    as f64)
                                    .sqrt()
                                    < MAX_DBLCLICK_DISTANCE
                        }
                        None => false,
                    };
                    *last = Some((now, release_pos.0, release_pos.1));
                    drop(last);

                    // Update opacity / dismiss based on where the mouse ended
                    // up relative to the popup (fade-and-hide, not an instant
                    // hide). If the click was on the popup it stays visible.
                    update_popup_opacity(release_pos.0, release_pos.1);

                    // Trigger only on a real drag selection or double click,
                    // AND only when the press started on a text I-beam cursor.
                    // Non-I-beam presses (dragging a file, a window, or a
                    // screenshot/crop rubber band) are regular drags, not
                    // selections, so we must not hijack them.
                    if from_ibeam
                        && (drag_dist >= MIN_DRAG_DISTANCE || is_double)
                        && !POPUP_PENDING.swap(true, Ordering::SeqCst)
                    {
                        thread::spawn(|| {
                            // Always clear the pending flag when this attempt ends
                            // (see PendingGuard), even if handle_selection panics.
                            let _pending_guard = PendingGuard;
                            // Wait for the selection to settle (caret/text to register)
                            thread::sleep(Duration::from_millis(50));
                            // Isolate any panic so it can't poison shared Mutexes
                            // or unwind the spawned thread.
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                                || handle_selection(),
                            ));
                        });
                    }
                }
                _ => (),
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }

    // Fade the popup as the mouse moves away and hide it once fully
    // transparent. Distance is measured from the nearest edge of the popup
    // rectangle (negative distance = cursor over the popup). Within
    // POPUP_VISIBLE_MARGIN it's fully opaque; beyond POPUP_FADE_MARGIN it's
    // hidden; in between opacity interpolates linearly.
    fn update_popup_opacity(x: i32, y: i32) {
        // Fast path: popup hidden, so do nothing at all. No window lookup,
        // no cross-thread Tauri call, no IPC. This runs on the global mouse
        // hook thread, so keeping it this cheap is what keeps the system
        // mouse feel identical to the no-popup build while the popup is away.
        if !POPUP_VISIBLE.load(Ordering::SeqCst) {
            return;
        }
        let app_handle = match crate::APP.get() {
            Some(h) => h,
            None => return,
        };
        let window = match app_handle.get_window("popup") {
            Some(w) => w,
            None => return,
        };
        let pos = match window.outer_position() {
            Ok(p) => p,
            Err(_) => return,
        };
        let size = match window.outer_size() {
            Ok(s) => s,
            Err(_) => return,
        };
        let (px, py) = (pos.x as i32, pos.y as i32);
        let (w, h) = (size.width as i32, size.height as i32);
        // Signed distance from the popup rectangle (0 if inside).
        let dx = if x < px {
            px - x
        } else if x > px + w {
            x - (px + w)
        } else {
            0
        };
        let dy = if y < py {
            py - y
        } else if y > py + h {
            y - (py + h)
        } else {
            0
        };
        let dist = ((dx * dx + dy * dy) as f64).sqrt() as i32;

        // Distance (px) from the popup at which it fully fades out and hides,
        // user-configurable (popup_fade_distance).
        let fade_margin = get("popup_fade_distance")
            .and_then(|v| v.as_i64())
            .unwrap_or(POPUP_FADE_MARGIN as i64)
            .clamp(30, 1200) as i32;

        if dist >= fade_margin {
            // Fully faded out — emit opacity 0 then hide it. Tauri 1.8 has no
            // window-level setOpacity, so the frontend applies the value to the
            // card via CSS and we hide from Rust.
            let _ = window.emit("popup_opacity", 0.0f64);
            POPUP_VISIBLE.store(false, Ordering::SeqCst);
            let _ = window.hide();
            return;
        }

        // Map distance -> opacity: base at VISIBLE_MARGIN, 0.0 at fade_margin.
        // The base (maximum) opacity is user-configurable (popup_opacity).
        let span = (fade_margin - POPUP_VISIBLE_MARGIN).max(1) as f64;
        let d = (dist - POPUP_VISIBLE_MARGIN).max(0) as f64;
        let base = get("popup_opacity")
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0)
            .clamp(0.0, 1.0);
        let opacity = (base * (1.0 - d / span)).clamp(0.0, base);

        // Avoid spamming the event on every mouse move: only emit when the
        // value actually changed meaningfully.
        static LAST_OPACITY: Mutex<f64> = Mutex::new(1.0);
        let mut last = LAST_OPACITY.lock().unwrap_or_else(|e| e.into_inner());
        if (opacity - *last).abs() > 0.04 {
            let _ = window.emit("popup_opacity", opacity);
            *last = opacity;
        }
    }

    // Last click info for double-click detection
    static LAST_CLICK: Mutex<Option<(Instant, i32, i32)>> = Mutex::new(None);

    fn is_popup_enabled_for_current_process() -> bool {
        let enabled = match get("popup_enabled") {
            Some(v) => v.as_bool().unwrap_or(false),
            None => false,
        };
        if !enabled {
            return false;
        }

        let process_name = match get_foreground_process_name() {
            Some(name) => name.to_lowercase(),
            None => return true,
        };

        let mode = match get("popup_list_mode") {
            Some(v) => v.as_str().unwrap_or("blacklist").to_string(),
            None => "blacklist".to_string(),
        };

        let list: Vec<String> = match get("popup_process_list") {
            Some(v) => serde_json::from_value(v).unwrap_or_default(),
            None => Vec::new(),
        };

        let list_lower: Vec<String> = list.iter().map(|s| s.to_lowercase()).collect();

        match mode.as_str() {
            "whitelist" => list_lower.contains(&process_name),
            _ => !list_lower.contains(&process_name),
        }
    }

    fn handle_selection() {
        if !is_popup_enabled_for_current_process() {
            return;
        }

        // Use the SAME proven selection pipeline as the translate hotkey
        // (the `selection` crate: UIAutomation first, then a clipboard Ctrl+C
        // fallback that restores the previous clipboard). It reads the live
        // selection from the foreground window, so it works in browsers, Office,
        // VS Code, Notepad, Electron, etc. — without depending on the fragile
        // I-Beam cursor-shape comparison that previously blocked the popup in
        // most applications. The popup window is created non-focused, so the
        // source app stays in the foreground and the selection is read correctly.
        let text = selection::get_text();
        if text.trim().is_empty() {
            return;
        }

        info!(
            "Popup: selected text = {}",
            &text[..text.len().min(50)]
        );
        // Store text so the frontend can fetch it on mount
        *crate::POPUP_TEXT
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = text.clone();
        popup_window(text);
    }

    pub fn start_popup_monitor() {
        if POPUP_RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }

        let enabled = match get("popup_enabled") {
            Some(v) => v.as_bool().unwrap_or(false),
            None => {
                set("popup_enabled", false);
                false
            }
        };

        if !enabled {
            POPUP_RUNNING.store(false, Ordering::SeqCst);
            return;
        }

        info!("Starting popup monitor...");
        thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

                let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0);
                match hook {
                    Ok(h) => {
                        info!("Mouse hook installed successfully");
                        HOOK_THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
                        let mut msg = MSG::default();
                        // Blocking message pump: required for low-level hook callbacks
                        // to be dispatched promptly (PeekMessage + sleep causes mouse lag).
                        loop {
                            let r = GetMessageW(&mut msg, None, 0, 0);
                            // 0 = WM_QUIT, -1 = error: exit loop
                            if r.0 <= 0 {
                                break;
                            }
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                        let _ = UnhookWindowsHookEx(h);
                        HOOK_THREAD_ID.store(0, Ordering::SeqCst);
                        info!("Mouse hook uninstalled");
                    }
                    Err(e) => {
                        warn!("Failed to install mouse hook: {:?}", e);
                    }
                }

                CoUninitialize();
                POPUP_RUNNING.store(false, Ordering::SeqCst);
            }
        });
    }

    pub fn stop_popup_monitor() {
        let thread_id = HOOK_THREAD_ID.load(Ordering::SeqCst);
        if thread_id != 0 {
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }

    // Synchronise the visibility cache from the window layer (window.rs shows
    // the popup directly on selection, so it must mark it visible here without
    // waiting for the frontend round-trip).
    pub fn popup_mark_visible(visible: bool) {
        POPUP_VISIBLE.store(visible, Ordering::SeqCst);
    }

    // Listen for frontend-driven show/hide so the hook thread's visibility
    // cache stays in sync when the WebView hides itself (translate/copy
    // buttons, blur, auto-close). The hook thread only ever reads the cache,
    // so this plain AtomicBool write is safe from any thread.
    pub fn init_popup_visibility(app: &tauri::AppHandle) {
        let app = app.clone();
        let _ = app.listen_global("popup_visible", move |event| {
            if let Some(payload) = event.payload() {
                if let Ok(v) = serde_json::from_str::<bool>(payload) {
                    POPUP_VISIBLE.store(v, Ordering::SeqCst);
                }
            }
        });
    }

    // EnumWindows only accepts a single LPARAM, so the PID->exe-name table and
    // the result vector are smuggled through one pointer to this struct.
    struct EnumAppsCtx {
        names: std::collections::BTreeMap<u32, String>,
        apps: Vec<PopupApp>,
    }

    // Callback for EnumWindows: keep the visible top-level windows that own a
    // title, and resolve each one back to its owner process's exe name.
    // Must stay `extern "system"` -- Windows calls it with the stdcall ABI.
    unsafe extern "system" fn collect_app_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let ctx = &mut *(lparam.0 as *mut EnumAppsCtx);
            if IsWindowVisible(hwnd).as_bool() {
                let len = GetWindowTextLengthW(hwnd);
                if len > 0 {
                    let mut buf = vec![0u16; (len + 1) as usize];
                    let n = GetWindowTextW(hwnd, &mut buf);
                    if n > 0 {
                        let mut pid: u32 = 0;
                        GetWindowThreadProcessId(hwnd, Some(&mut pid));
                        if let Some(name) = ctx.names.get(&pid) {
                            if !name.is_empty() {
                                ctx.apps.push(PopupApp {
                                    process: name.clone(),
                                    title: String::from_utf16_lossy(&buf[..n as usize]),
                                });
                            }
                        }
                    }
                }
            }
            // TRUE keeps the enumeration going.
            BOOL(1)
        }
    }

    // Enumerate the applications that currently own a visible, titled window.
    // The settings page uses this so the user can *pick* an app for the popup
    // blacklist/whitelist instead of having to already know its exe name.
    //
    // Only windowed apps are listed on purpose: enumerating processes instead
    // would return 100+ background service hosts, which is useless for
    // "which app should show the popup?". Result is deduped by exe name (a
    // browser with 20 windows is one entry) and sorted for a stable UI.
    #[tauri::command]
    pub fn popup_list_applications() -> Vec<PopupApp> {
        use std::collections::{BTreeMap, HashSet};

        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        let mut names: BTreeMap<u32, String> = BTreeMap::new();
        unsafe {
            if let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                let mut entry = PROCESSENTRY32W {
                    dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                    ..Default::default()
                };
                if Process32FirstW(snapshot, &mut entry).is_ok() {
                    loop {
                        names.insert(
                            entry.th32ProcessID,
                            String::from_utf16_lossy(&entry.szExeFile)
                                .trim_end_matches('\0')
                                .to_string(),
                        );
                        if Process32NextW(snapshot, &mut entry).is_err() {
                            break;
                        }
                    }
                }
                let _ = CloseHandle(snapshot);
            }
        }

        let mut ctx = EnumAppsCtx {
            names,
            apps: Vec::new(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(collect_app_window),
                LPARAM(&mut ctx as *mut EnumAppsCtx as isize),
            );
        }

        let mut seen: HashSet<String> = HashSet::new();
        let mut apps: Vec<PopupApp> = ctx
            .apps
            .into_iter()
            .filter(|a| seen.insert(a.process.to_lowercase()))
            .collect();
        apps.sort_by_key(|a| a.process.to_lowercase());
        apps
    }

    #[tauri::command]
    pub fn popup_get_foreground_process() -> String {
        get_foreground_process_name().unwrap_or_default()
    }

    #[tauri::command]
    pub fn popup_set_enabled(enabled: bool) {
        set("popup_enabled", enabled);
        if enabled {
            start_popup_monitor();
        } else {
            stop_popup_monitor();
        }
    }

    // Translate from the popup: translate the text that was already captured
    // when the popup appeared (stored in POPUP_TEXT), rather than re-reading the
    // live selection from the foreground window. This avoids the focus
    // tug-of-war (the popup grabs focus when its button is clicked, so a live
    // foreground re-read would read the empty popup) that previously made the
    // translate button appear to do nothing. The WebView is hidden by the
    // frontend (and here as a safeguard) after this command returns.
    #[tauri::command]
    pub fn popup_translate() {
        // Clicking "translate" on the popup == literally pressing the user's
        // configured translate hotkey. We hide the popup (returning focus to
        // the source app), wait a tick for the OS to restore focus, then
        // simulate the hotkey via SendInput. Windows dispatches the synthesized
        // keystrokes to the global hotkey listener, which runs selection_translate
        // on the MAIN thread — the exact same path as a manual keypress, so no
        // window-creation deadlock and the text read is the real selection.
        if let Some(w) = crate::APP.get().map(|h| h.get_window("popup")).flatten() {
            POPUP_VISIBLE.store(false, Ordering::SeqCst);
            let _ = w.hide();
            // Give the OS a moment to return focus to the source app before the
            // synthesized keypress triggers selection_translate (which reads the
            // FOREGROUND window). This runs on a worker thread, so a brief sleep
            // here doesn't block the UI.
            thread::sleep(Duration::from_millis(80));
            // Read the user's current translate hotkey and simulate it.
            if let Some(hotkey) = get("hotkey_selection_translate").and_then(|v| v.as_str().map(|s| s.to_string())) {
                if !hotkey.trim().is_empty() {
                    simulate_hotkey(&hotkey);
                } else {
                    warn!("popup_translate: hotkey_selection_translate is empty");
                }
            } else {
                warn!("popup_translate: hotkey_selection_translate not found in config");
            }
        }
    }

    // Translate a Tauri/global-shortcut style hotkey string (e.g. "Alt+A",
    // "Ctrl+Shift+D", "CommandOrControl+F1") into a sequence of SendInput
    // keystrokes: all modifiers+key DOWN, then the reverse order UP. This makes
    // the OS raise the registered global hotkey exactly as a real keypress would.
    fn simulate_hotkey(hotkey: &str) {
        let mut parts: Vec<&str> = hotkey.split('+').map(|s| s.trim()).collect();
        if parts.is_empty() {
            return;
        }
        let key = match parts.pop() {
            Some(k) => k,
            None => return,
        };
        let mut vks: Vec<u16> = Vec::new();
        for m in &parts {
            if let Some(vk) = modifier_vk(m) {
                vks.push(vk);
            } else {
                warn!("popup_translate: unknown modifier '{}' in '{}'", m, hotkey);
            }
        }
        match key_vk(key) {
            Some(vk) => vks.push(vk),
            None => {
                warn!("popup_translate: unknown key '{}' in '{}'", key, hotkey);
                return;
            }
        }

        let mut inputs: Vec<INPUT> = Vec::with_capacity(vks.len() * 2);
        // Key DOWN for every key (modifiers first, then the primary key)
        for &vk in &vks {
            inputs.push(make_key_input(vk, false));
        }
        // Key UP in reverse order
        for &vk in vks.iter().rev() {
            inputs.push(make_key_input(vk, true));
        }

        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        info!("popup_translate: simulated '{}', SendInput sent {}/{}", hotkey, sent, inputs.len());
    }

    fn modifier_vk(modifier: &str) -> Option<u16> {
        match modifier.to_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" | "ctrlorcmd" | "cmdorctrl" => Some(0x11), // VK_CONTROL
            "alt" | "option" => Some(0x12), // VK_MENU
            "shift" => Some(0x10),          // VK_SHIFT
            "meta" | "super" | "command" | "cmd" | "win" | "windows" | "winlogo" => Some(0x5B), // VK_LWIN
            _ => None,
        }
    }

    fn key_vk(key: &str) -> Option<u16> {
        let lower = key.to_lowercase();
        // Single letter
        if lower.len() == 1 {
            let c = lower.chars().next().unwrap();
            if c.is_ascii_alphabetic() {
                return Some(0x41 + (c as u16 - b'a' as u16)); // VK_A..VK_Z
            }
            if c.is_ascii_digit() {
                return Some(0x30 + (c as u16 - b'0' as u16)); // VK_0..VK_9
            }
        }
        // Function keys F1..F12
        if let Some(rest) = lower.strip_prefix('f') {
            if let Ok(n) = rest.parse::<u32>() {
                if (1..=12).contains(&n) {
                    return Some(0x70 + (n - 1) as u16); // VK_F1..VK_F12
                }
            }
        }
        // A few common named keys
        match lower.as_str() {
            "space" => Some(0x20),
            "enter" | "return" => Some(0x0D),
            "tab" => Some(0x09),
            "escape" | "esc" => Some(0x1B),
            "backspace" => Some(0x08),
            "delete" | "del" => Some(0x2E),
            "up" => Some(0x26),
            "down" => Some(0x28),
            "left" => Some(0x25),
            "right" => Some(0x27),
            "," => Some(0xBC),
            "." => Some(0xBE),
            ";" => Some(0xBA),
            "/" => Some(0xBF),
            "\\" => Some(0xDC),
            "'" => Some(0xDE),
            "[" => Some(0xDB),
            "]" => Some(0xDD),
            "`" => Some(0xC0),
            "-"=> Some(0xBD),
            "="=> Some(0xBB),
            _ => None,
        }
    }

    fn make_key_input(vk: u16, up: bool) -> INPUT {
        let mut input = INPUT::default();
        input.r#type = INPUT_KEYBOARD;
        input.Anonymous.ki = KEYBDINPUT {
            wVk: VIRTUAL_KEY(vk),
            wScan: 0,
            dwFlags: if up {
                KEYEVENTF_KEYUP
            } else {
                KEYBD_EVENT_FLAGS(0)
            },
            time: 0,
            dwExtraInfo: 0,
        };
        input
    }
}

// Shared popup text: written by the hook thread, fetched by the frontend on mount
pub static POPUP_TEXT: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

#[cfg(target_os = "windows")]
pub use win_impl::{
    init_popup_visibility, popup_get_foreground_process, popup_list_applications,
    popup_mark_visible, popup_set_enabled, popup_translate, start_popup_monitor,
    stop_popup_monitor,
};

// Fetch the current popup text (called by Popup window on mount to avoid
// the emit-before-page-load race)
#[tauri::command]
pub fn popup_get_text() -> String {
    POPUP_TEXT.lock().unwrap().clone()
}

// Fetch the popup's user-configured base opacity (0..1). The frontend uses
// this as the initial/restored card opacity so a translucent popup does not
// flash fully opaque on show.
#[tauri::command]
pub fn popup_get_preferences() -> f64 {
    crate::config::get("popup_opacity")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0)
        .clamp(0.0, 1.0)
}

#[cfg(not(target_os = "windows"))]
pub fn init_popup_visibility(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "windows"))]
pub fn popup_mark_visible(_visible: bool) {}
#[cfg(not(target_os = "windows"))]
pub fn popup_translate() {}
#[cfg(not(target_os = "windows"))]
pub fn stop_popup_monitor() {}
#[cfg(not(target_os = "windows"))]
pub fn popup_get_foreground_process() -> String {
    String::new()
}
// Window enumeration is a Windows-only feature; other platforms get an empty
// picker rather than an IPC error.
#[cfg(not(target_os = "windows"))]
pub fn popup_list_applications() -> Vec<PopupApp> {
    Vec::new()
}
#[cfg(not(target_os = "windows"))]
pub fn popup_set_enabled(_enabled: bool) {}
