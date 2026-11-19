/**
 * AI Q&A: reuse a configured translation service instance as a chat backend,
 * but with NO translation prompt.
 *
 * The translate services all accept a `promptList` in their config and
 * substitute $text/$from/$to/$detect into it. For Q&A we want the opposite of
 * that: the user's question goes straight to the model, with no "translate
 * this" instruction attached. So instead of going through
 * `translate(text, from, to, {config})`, we synthesize a one-shot service
 * config whose promptList is a single user turn containing the question —
 * and pass "auto"/"auto" as languages so the providers never need a real
 * language pair.
 *
 * Only LLM-backed services understand promptList (openai / ollama / chatglm /
 * geminipro); dictionary-style services (bing_dict, ecdict, ...) have no chat
 * endpoint and would always fail, hence ASK_SERVICE_LIST below.
 */

// The services that expose a chat-completion style `promptList`.
// Keep in sync with the `promptList` users in src/services/translate/*.
export const ASK_SERVICE_LIST = ['openai', 'ollama', 'chatglm', 'geminipro'];

export function supportsAsk(serviceName) {
    return ASK_SERVICE_LIST.includes(serviceName);
}

// Keep the last N messages as context. Ten rounds is enough for the "ask about
// a term while translating" use case while staying well inside any provider's
// context window (and keeping the persisted config small).
export const ASK_HISTORY_LIMIT = 20;

// geminipro stores turns as {role, parts:[{text}]} rather than {role, content},
// and calls the assistant role "model".
function toTurn(serviceName, role, content) {
    if (serviceName === 'geminipro') {
        return {
            role: role === 'assistant' ? 'model' : 'user',
            parts: [{ text: content }],
        };
    }
    return { role, content };
}

/**
 * Build the transport config for a conversation.
 *
 * `turns` is the full ordered list of {role, content} for this request,
 * including the new question. We deliberately do NOT reuse the instance's
 * promptList: that list carries the translation system prompt ("Translate into
 * $to ..."), which would make the model translate the question instead of
 * answering it. Everything else in the instance config (endpoint, model, api
 * key, streaming, request arguments) is preserved, so asking uses exactly the
 * same provider the user already configured.
 */
export function buildAskConfig(instanceConfig, serviceName, turns) {
    return {
        ...instanceConfig,
        promptList: turns.map((t) => toTurn(serviceName, t.role, t.content)),
    };
}

/**
 * Trim the conversation to the last ASK_HISTORY_LIMIT messages. Failed turns
 * are dropped entirely -- an error string is a UI artefact, not conversation
 * context, and replaying it confuses the model.
 *
 * A retained conversation must always start with a user turn: some providers
 * reject a leading assistant message, which happens naturally once an old
 * exchange falls off the front of the window.
 */
export function trimHistory(messages, limit = ASK_HISTORY_LIMIT) {
    if (!Array.isArray(messages)) return [];
    const usable = messages.filter(
        (m) => m && !m.error && (m.role === 'user' || m.role === 'assistant') && m.content !== ''
    );
    let out = usable.slice(-limit);
    while (out.length > 0 && out[0].role !== 'user') {
        out = out.slice(1);
    }
    return out.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Strip the streaming sentinel and the wrapper quotes some providers add.
 * The LLM services signal "token appended" by calling setResult(target + '_'),
 * and openai removes surrounding double quotes on the non-stream path.
 */
export function cleanAnswer(text) {
    if (typeof text !== 'string') return '';
    let out = text;
    // Exactly one sentinel: the providers do `setResult(target + '_')` on each
    // chunk, so at most one trailing underscore is ours. Stripping all of them
    // would corrupt an answer that legitimately ends with underscores.
    if (out.endsWith('_')) {
        out = out.slice(0, -1);
    }
    out = out.trim();
    if (out.startsWith('"') && out.endsWith('"') && out.length > 1) {
        const inner = out.slice(1, -1);
        // only unwrap when the quotes really wrap the whole thing
        if (!inner.includes('"')) out = inner;
    }
    return out.trim();
}
