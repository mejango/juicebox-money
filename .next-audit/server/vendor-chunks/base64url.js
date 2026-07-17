/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
exports.id = "vendor-chunks/base64url";
exports.ids = ["vendor-chunks/base64url"];
exports.modules = {

/***/ "(ssr)/./node_modules/base64url/dist/base64url.js":
/*!**************************************************!*\
  !*** ./node_modules/base64url/dist/base64url.js ***!
  \**************************************************/
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

"use strict";
eval("\nObject.defineProperty(exports, \"__esModule\", ({ value: true }));\nvar pad_string_1 = __webpack_require__(/*! ./pad-string */ \"(ssr)/./node_modules/base64url/dist/pad-string.js\");\nfunction encode(input, encoding) {\n    if (encoding === void 0) { encoding = \"utf8\"; }\n    if (Buffer.isBuffer(input)) {\n        return fromBase64(input.toString(\"base64\"));\n    }\n    return fromBase64(Buffer.from(input, encoding).toString(\"base64\"));\n}\n;\nfunction decode(base64url, encoding) {\n    if (encoding === void 0) { encoding = \"utf8\"; }\n    return Buffer.from(toBase64(base64url), \"base64\").toString(encoding);\n}\nfunction toBase64(base64url) {\n    base64url = base64url.toString();\n    return pad_string_1.default(base64url)\n        .replace(/\\-/g, \"+\")\n        .replace(/_/g, \"/\");\n}\nfunction fromBase64(base64) {\n    return base64\n        .replace(/=/g, \"\")\n        .replace(/\\+/g, \"-\")\n        .replace(/\\//g, \"_\");\n}\nfunction toBuffer(base64url) {\n    return Buffer.from(toBase64(base64url), \"base64\");\n}\nvar base64url = encode;\nbase64url.encode = encode;\nbase64url.decode = decode;\nbase64url.toBase64 = toBase64;\nbase64url.fromBase64 = fromBase64;\nbase64url.toBuffer = toBuffer;\nexports[\"default\"] = base64url;\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHNzcikvLi9ub2RlX21vZHVsZXMvYmFzZTY0dXJsL2Rpc3QvYmFzZTY0dXJsLmpzIiwibWFwcGluZ3MiOiJBQUFhO0FBQ2IsOENBQTZDLEVBQUUsYUFBYSxFQUFDO0FBQzdELG1CQUFtQixtQkFBTyxDQUFDLHVFQUFjO0FBQ3pDO0FBQ0EsK0JBQStCO0FBQy9CO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsK0JBQStCO0FBQy9CO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxrQkFBZSIsInNvdXJjZXMiOlsid2VicGFjazovL2p1aWNlYm94LW1vbmV5LXY2Ly4vbm9kZV9tb2R1bGVzL2Jhc2U2NHVybC9kaXN0L2Jhc2U2NHVybC5qcz9jZjAzIl0sInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuT2JqZWN0LmRlZmluZVByb3BlcnR5KGV4cG9ydHMsIFwiX19lc01vZHVsZVwiLCB7IHZhbHVlOiB0cnVlIH0pO1xudmFyIHBhZF9zdHJpbmdfMSA9IHJlcXVpcmUoXCIuL3BhZC1zdHJpbmdcIik7XG5mdW5jdGlvbiBlbmNvZGUoaW5wdXQsIGVuY29kaW5nKSB7XG4gICAgaWYgKGVuY29kaW5nID09PSB2b2lkIDApIHsgZW5jb2RpbmcgPSBcInV0ZjhcIjsgfVxuICAgIGlmIChCdWZmZXIuaXNCdWZmZXIoaW5wdXQpKSB7XG4gICAgICAgIHJldHVybiBmcm9tQmFzZTY0KGlucHV0LnRvU3RyaW5nKFwiYmFzZTY0XCIpKTtcbiAgICB9XG4gICAgcmV0dXJuIGZyb21CYXNlNjQoQnVmZmVyLmZyb20oaW5wdXQsIGVuY29kaW5nKS50b1N0cmluZyhcImJhc2U2NFwiKSk7XG59XG47XG5mdW5jdGlvbiBkZWNvZGUoYmFzZTY0dXJsLCBlbmNvZGluZykge1xuICAgIGlmIChlbmNvZGluZyA9PT0gdm9pZCAwKSB7IGVuY29kaW5nID0gXCJ1dGY4XCI7IH1cbiAgICByZXR1cm4gQnVmZmVyLmZyb20odG9CYXNlNjQoYmFzZTY0dXJsKSwgXCJiYXNlNjRcIikudG9TdHJpbmcoZW5jb2RpbmcpO1xufVxuZnVuY3Rpb24gdG9CYXNlNjQoYmFzZTY0dXJsKSB7XG4gICAgYmFzZTY0dXJsID0gYmFzZTY0dXJsLnRvU3RyaW5nKCk7XG4gICAgcmV0dXJuIHBhZF9zdHJpbmdfMS5kZWZhdWx0KGJhc2U2NHVybClcbiAgICAgICAgLnJlcGxhY2UoL1xcLS9nLCBcIitcIilcbiAgICAgICAgLnJlcGxhY2UoL18vZywgXCIvXCIpO1xufVxuZnVuY3Rpb24gZnJvbUJhc2U2NChiYXNlNjQpIHtcbiAgICByZXR1cm4gYmFzZTY0XG4gICAgICAgIC5yZXBsYWNlKC89L2csIFwiXCIpXG4gICAgICAgIC5yZXBsYWNlKC9cXCsvZywgXCItXCIpXG4gICAgICAgIC5yZXBsYWNlKC9cXC8vZywgXCJfXCIpO1xufVxuZnVuY3Rpb24gdG9CdWZmZXIoYmFzZTY0dXJsKSB7XG4gICAgcmV0dXJuIEJ1ZmZlci5mcm9tKHRvQmFzZTY0KGJhc2U2NHVybCksIFwiYmFzZTY0XCIpO1xufVxudmFyIGJhc2U2NHVybCA9IGVuY29kZTtcbmJhc2U2NHVybC5lbmNvZGUgPSBlbmNvZGU7XG5iYXNlNjR1cmwuZGVjb2RlID0gZGVjb2RlO1xuYmFzZTY0dXJsLnRvQmFzZTY0ID0gdG9CYXNlNjQ7XG5iYXNlNjR1cmwuZnJvbUJhc2U2NCA9IGZyb21CYXNlNjQ7XG5iYXNlNjR1cmwudG9CdWZmZXIgPSB0b0J1ZmZlcjtcbmV4cG9ydHMuZGVmYXVsdCA9IGJhc2U2NHVybDtcbiJdLCJuYW1lcyI6W10sInNvdXJjZVJvb3QiOiIifQ==\n//# sourceURL=webpack-internal:///(ssr)/./node_modules/base64url/dist/base64url.js\n");

/***/ }),

/***/ "(ssr)/./node_modules/base64url/dist/pad-string.js":
/*!***************************************************!*\
  !*** ./node_modules/base64url/dist/pad-string.js ***!
  \***************************************************/
/***/ ((__unused_webpack_module, exports) => {

"use strict";
eval("\nObject.defineProperty(exports, \"__esModule\", ({ value: true }));\nfunction padString(input) {\n    var segmentLength = 4;\n    var stringLength = input.length;\n    var diff = stringLength % segmentLength;\n    if (!diff) {\n        return input;\n    }\n    var position = stringLength;\n    var padLength = segmentLength - diff;\n    var paddedStringLength = stringLength + padLength;\n    var buffer = Buffer.alloc(paddedStringLength);\n    buffer.write(input);\n    while (padLength--) {\n        buffer.write(\"=\", position++);\n    }\n    return buffer.toString();\n}\nexports[\"default\"] = padString;\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHNzcikvLi9ub2RlX21vZHVsZXMvYmFzZTY0dXJsL2Rpc3QvcGFkLXN0cmluZy5qcyIsIm1hcHBpbmdzIjoiQUFBYTtBQUNiLDhDQUE2QyxFQUFFLGFBQWEsRUFBQztBQUM3RDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0Esa0JBQWUiLCJzb3VyY2VzIjpbIndlYnBhY2s6Ly9qdWljZWJveC1tb25leS12Ni8uL25vZGVfbW9kdWxlcy9iYXNlNjR1cmwvZGlzdC9wYWQtc3RyaW5nLmpzPzA5NjkiXSwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5PYmplY3QuZGVmaW5lUHJvcGVydHkoZXhwb3J0cywgXCJfX2VzTW9kdWxlXCIsIHsgdmFsdWU6IHRydWUgfSk7XG5mdW5jdGlvbiBwYWRTdHJpbmcoaW5wdXQpIHtcbiAgICB2YXIgc2VnbWVudExlbmd0aCA9IDQ7XG4gICAgdmFyIHN0cmluZ0xlbmd0aCA9IGlucHV0Lmxlbmd0aDtcbiAgICB2YXIgZGlmZiA9IHN0cmluZ0xlbmd0aCAlIHNlZ21lbnRMZW5ndGg7XG4gICAgaWYgKCFkaWZmKSB7XG4gICAgICAgIHJldHVybiBpbnB1dDtcbiAgICB9XG4gICAgdmFyIHBvc2l0aW9uID0gc3RyaW5nTGVuZ3RoO1xuICAgIHZhciBwYWRMZW5ndGggPSBzZWdtZW50TGVuZ3RoIC0gZGlmZjtcbiAgICB2YXIgcGFkZGVkU3RyaW5nTGVuZ3RoID0gc3RyaW5nTGVuZ3RoICsgcGFkTGVuZ3RoO1xuICAgIHZhciBidWZmZXIgPSBCdWZmZXIuYWxsb2MocGFkZGVkU3RyaW5nTGVuZ3RoKTtcbiAgICBidWZmZXIud3JpdGUoaW5wdXQpO1xuICAgIHdoaWxlIChwYWRMZW5ndGgtLSkge1xuICAgICAgICBidWZmZXIud3JpdGUoXCI9XCIsIHBvc2l0aW9uKyspO1xuICAgIH1cbiAgICByZXR1cm4gYnVmZmVyLnRvU3RyaW5nKCk7XG59XG5leHBvcnRzLmRlZmF1bHQgPSBwYWRTdHJpbmc7XG4iXSwibmFtZXMiOltdLCJzb3VyY2VSb290IjoiIn0=\n//# sourceURL=webpack-internal:///(ssr)/./node_modules/base64url/dist/pad-string.js\n");

/***/ }),

/***/ "(ssr)/./node_modules/base64url/index.js":
/*!*****************************************!*\
  !*** ./node_modules/base64url/index.js ***!
  \*****************************************/
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

eval("module.exports = __webpack_require__(/*! ./dist/base64url */ \"(ssr)/./node_modules/base64url/dist/base64url.js\")[\"default\"];\nmodule.exports[\"default\"] = module.exports;\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKHNzcikvLi9ub2RlX21vZHVsZXMvYmFzZTY0dXJsL2luZGV4LmpzIiwibWFwcGluZ3MiOiJBQUFBLDJIQUFvRDtBQUNwRCx5QkFBc0IiLCJzb3VyY2VzIjpbIndlYnBhY2s6Ly9qdWljZWJveC1tb25leS12Ni8uL25vZGVfbW9kdWxlcy9iYXNlNjR1cmwvaW5kZXguanM/OWQ3NiJdLCJzb3VyY2VzQ29udGVudCI6WyJtb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoJy4vZGlzdC9iYXNlNjR1cmwnKS5kZWZhdWx0O1xubW9kdWxlLmV4cG9ydHMuZGVmYXVsdCA9IG1vZHVsZS5leHBvcnRzO1xuIl0sIm5hbWVzIjpbXSwic291cmNlUm9vdCI6IiJ9\n//# sourceURL=webpack-internal:///(ssr)/./node_modules/base64url/index.js\n");

/***/ })

};
;