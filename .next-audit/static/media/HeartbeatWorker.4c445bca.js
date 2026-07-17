// Copyright (c) 2018-2025 Coinbase, Inc. <https://www.coinbase.com/>
//
// Verbatim copy of @coinbase/wallet-sdk@4.3.0
// dist/sign/walletlink/relay/connection/HeartbeatWorker.js with the trailing
// `export {}` module marker removed: webpack emits this worker as a classic
// (non-module) script, and Next's minifier rejects `export` in that context.
// Swapped in via NormalModuleReplacementPlugin in next.config.js.
/**
 * This worker is used to send heartbeat messages to the main thread.
 * It is used to keep the websocket connection alive when the webpage is backgrounded.
 *
 */ const HEARTBEAT_INTERVAL = 10000; // 10 seconds
let heartbeatInterval;
// Listen for messages from the main thread
self.addEventListener("message", (event)=>{
    const { type } = event.data;
    switch(type){
        case "start":
            startHeartbeat();
            break;
        case "stop":
            stopHeartbeat();
            break;
        default:
            console.warn("Unknown message type received by HeartbeatWorker:", type);
    }
});
function startHeartbeat() {
    // Clear any existing interval
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    // Start the heartbeat interval
    heartbeatInterval = setInterval(()=>{
        // Send heartbeat message to main thread
        const response = {
            type: "heartbeat"
        };
        self.postMessage(response);
    }, HEARTBEAT_INTERVAL);
    // Send confirmation that heartbeat started
    const response = {
        type: "started"
    };
    self.postMessage(response);
}
function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
    }
    // Send confirmation that heartbeat stopped
    const response = {
        type: "stopped"
    };
    self.postMessage(response);
}
// Handle worker termination
self.addEventListener("beforeunload", ()=>{
    stopHeartbeat();
});


;
    // Wrapped in an IIFE to avoid polluting the global scope
    ;
    (function () {
        var _a, _b;
        // Legacy CSS implementations will `eval` browser code in a Node.js context
        // to extract CSS. For backwards compatibility, we need to check we're in a
        // browser context before continuing.
        if (typeof self !== 'undefined' &&
            // AMP / No-JS mode does not inject these helpers:
            '$RefreshHelpers$' in self) {
            // @ts-ignore __webpack_module__ is global
            var currentExports = __webpack_module__.exports;
            // @ts-ignore __webpack_module__ is global
            var prevSignature = (_b = (_a = __webpack_module__.hot.data) === null || _a === void 0 ? void 0 : _a.prevSignature) !== null && _b !== void 0 ? _b : null;
            // This cannot happen in MainTemplate because the exports mismatch between
            // templating and execution.
            self.$RefreshHelpers$.registerExportsForReactRefresh(currentExports, __webpack_module__.id);
            // A module can be accepted automatically based on its exports, e.g. when
            // it is a Refresh Boundary.
            if (self.$RefreshHelpers$.isReactRefreshBoundary(currentExports)) {
                // Save the previous exports signature on update so we can compare the boundary
                // signatures. We avoid saving exports themselves since it causes memory leaks (https://github.com/vercel/next.js/pull/53797)
                __webpack_module__.hot.dispose(function (data) {
                    data.prevSignature =
                        self.$RefreshHelpers$.getRefreshBoundarySignature(currentExports);
                });
                // Unconditionally accept an update to this module, we'll check if it's
                // still a Refresh Boundary later.
                // @ts-ignore importMeta is replaced in the loader
                import.meta.webpackHot.accept();
                // This field is set when the previous version of this module was a
                // Refresh Boundary, letting us know we need to check for invalidation or
                // enqueue an update.
                if (prevSignature !== null) {
                    // A boundary can become ineligible if its exports are incompatible
                    // with the previous exports.
                    //
                    // For example, if you add/remove/change exports, we'll want to
                    // re-execute the importing modules, and force those components to
                    // re-render. Similarly, if you convert a class component to a
                    // function, we want to invalidate the boundary.
                    if (self.$RefreshHelpers$.shouldInvalidateReactRefreshBoundary(prevSignature, self.$RefreshHelpers$.getRefreshBoundarySignature(currentExports))) {
                        __webpack_module__.hot.invalidate();
                    }
                    else {
                        self.$RefreshHelpers$.scheduleUpdate();
                    }
                }
            }
            else {
                // Since we just executed the code for the module, it's possible that the
                // new exports made it ineligible for being a boundary.
                // We only care about the case when we were _previously_ a boundary,
                // because we already accepted this update (accidental side effect).
                var isNoLongerABoundary = prevSignature !== null;
                if (isNoLongerABoundary) {
                    __webpack_module__.hot.invalidate();
                }
            }
        }
    })();
