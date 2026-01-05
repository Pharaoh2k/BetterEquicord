/**
 * @template T
 * @param {T[]} arr
 * @param {(v: T) => boolean} predicate
 */
function removeFirst(arr, predicate) {
    const idx = arr.findIndex(predicate);
    if (idx !== -1) arr.splice(idx, 1);
}

chrome.webRequest.onHeadersReceived.addListener(
    ({ responseHeaders, type, url }) => {
        if (!responseHeaders) return;

        if (type === "main_frame" && url.includes("discord.com")) {
            // In main frame requests, the CSP needs to be removed to enable fetching of custom css
            // as desired by the user
            removeFirst(responseHeaders, h => h.name.toLowerCase() === "content-security-policy");
        } else if (type === "stylesheet" && url.startsWith("https://raw.githubusercontent.com/")) {
            // Most users will load css from GitHub, but GitHub doesn't set the correct content type,
            // so we fix it here
            removeFirst(responseHeaders, h => h.name.toLowerCase() === "content-type");
            responseHeaders.push({
                name: "Content-Type",
                value: "text/css"
            });
        }
        return { responseHeaders };
    },
    { urls: ["https://raw.githubusercontent.com/*", "*://*.discord.com/*"], types: ["main_frame", "stylesheet"] },
    ["blocking", "responseHeaders"]
);

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
        return true;
    }
});
