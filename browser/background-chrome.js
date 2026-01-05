// BD Compat Layer: Handle CORS-free fetch requests for Discord CDN
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "EQUICORD_CORS_FETCH") {
        fetch(request.url)
            .then(async response => {
                const buffer = await response.arrayBuffer();
                const bytes = new Uint8Array(buffer);
                let binary = "";
                for (let i = 0; i < bytes.length; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                const base64 = btoa(binary);
                sendResponse({
                    ok: response.ok,
                    status: response.status,
                    body: base64
                });
            })
            .catch(e => {
                sendResponse({ error: e.message });
            });
        return true; // Keep channel open for async response
    }
});
