if (typeof browser === "undefined") {
    var browser = chrome;
}

document.addEventListener(
    "DOMContentLoaded",
    () => {
        window.postMessage({
            type: "vencord:meta",
            meta: {
                EXTENSION_VERSION: browser.runtime.getManifest().version,
                EXTENSION_BASE_URL: browser.runtime.getURL(""),
                RENDERER_CSS_URL: browser.runtime.getURL("dist/Equicord.css"),
            }
        });
    },
    { once: true }
);

// BD Compat Layer: Relay CORS fetch requests from MAIN world to background service worker
window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "EQUICORD_CORS_FETCH_REQUEST") return;

    const { url, requestId } = event.data;

    try {
        const response = await browser.runtime.sendMessage({
            type: "EQUICORD_CORS_FETCH",
            url: url
        });

        window.postMessage({
            type: "EQUICORD_CORS_FETCH_RESPONSE",
            requestId: requestId,
            response: response
        });
    } catch (error) {
        window.postMessage({
            type: "EQUICORD_CORS_FETCH_RESPONSE",
            requestId: requestId,
            response: { error: error.message }
        });
    }
});
