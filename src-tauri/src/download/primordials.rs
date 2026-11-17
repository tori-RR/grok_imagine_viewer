const PRIMORDIALS_GLOBAL: &str = "__giv_native_primordials_v1_6f36b8f2";

const INITIALIZATION_SCRIPT: &str = r#"(() => {
  "use strict";
  const root = globalThis;
  const key = "__giv_native_primordials_v1_6f36b8f2";
  const ObjectCtor = Object;
  const ReflectCtor = Reflect;
  const getOwnPropertyDescriptor = ObjectCtor.getOwnPropertyDescriptor;
  const getPrototypeOf = ObjectCtor.getPrototypeOf;
  const defineProperty = ObjectCtor.defineProperty;
  const freeze = ObjectCtor.freeze;
  const isFrozen = ObjectCtor.isFrozen;
  const apply = ReflectCtor.apply;
  const construct = ReflectCtor.construct;

  if (getOwnPropertyDescriptor(root, key) !== undefined) return;

  const StringCtor = String;
  const ArrayCtor = Array;
  const NumberCtor = Number;
  const RegExpCtor = RegExp;
  const PromiseCtor = Promise;
  const URLCtor = URL;
  const URLSearchParamsCtor = URLSearchParams;
  const BlobCtor = Blob;
  const MapCtor = Map;
  const AbortControllerCtor = AbortController;
  const AbortSignalCtor = AbortSignal;
  const Uint8ArrayCtor = Uint8Array;
  const DOMExceptionCtor = DOMException;
  const ResponseCtor = Response;
  const HeadersCtor = Headers;
  const ReadableStreamCtor = ReadableStream;
  const ReadableStreamDefaultReaderCtor = ReadableStreamDefaultReader;
  const EventTargetCtor = EventTarget;
  const DocumentCtor = Document;
  const HTMLAnchorElementCtor = HTMLAnchorElement;
  const documentValue = document;

  const nativeFetch = root.fetch;
  const nativeSetTimeout = root.setTimeout;
  const nativeClearTimeout = root.clearTimeout;
  const nativeEncodeURIComponent = root.encodeURIComponent;
  const nativeCreateObjectURL = URLCtor.createObjectURL;
  const nativeRevokeObjectURL = URLCtor.revokeObjectURL;
  const stringStartsWith = StringCtor.prototype.startsWith;
  const stringEndsWith = StringCtor.prototype.endsWith;
  const stringIncludes = StringCtor.prototype.includes;
  const stringSlice = StringCtor.prototype.slice;
  const stringSplit = StringCtor.prototype.split;
  const stringTrim = StringCtor.prototype.trim;
  const stringToLowerCase = StringCtor.prototype.toLowerCase;
  const arrayIsArray = ArrayCtor.isArray;
  const arrayPush = ArrayCtor.prototype.push;
  const arrayJoin = ArrayCtor.prototype.join;
  const numberIsSafeInteger = NumberCtor.isSafeInteger;
  const regexpTest = RegExpCtor.prototype.test;
  const jsonStringify = JSON.stringify;
  const mathMin = Math.min;
  const mapGet = MapCtor.prototype.get;
  const mapSet = MapCtor.prototype.set;
  const mapDelete = MapCtor.prototype.delete;
  const abortControllerAbort = AbortControllerCtor.prototype.abort;
  const abortControllerSignal = getOwnPropertyDescriptor(
    AbortControllerCtor.prototype,
    "signal"
  ).get;
  const abortSignalAborted = getOwnPropertyDescriptor(
    AbortSignalCtor.prototype,
    "aborted"
  ).get;
  const typedArrayPrototype = getPrototypeOf(Uint8ArrayCtor.prototype);
  const uint8ByteLength = getOwnPropertyDescriptor(
    typedArrayPrototype,
    "byteLength"
  ).get;
  const eventTargetAdd = EventTargetCtor.prototype.addEventListener;
  const eventTargetRemove = EventTargetCtor.prototype.removeEventListener;
  const urlPathname = getOwnPropertyDescriptor(URLCtor.prototype, "pathname");
  const urlProtocol = getOwnPropertyDescriptor(URLCtor.prototype, "protocol").get;
  const urlHostname = getOwnPropertyDescriptor(URLCtor.prototype, "hostname").get;
  const urlSearchParams = getOwnPropertyDescriptor(URLCtor.prototype, "searchParams").get;
  const urlToString = URLCtor.prototype.toString;
  const urlSearchParamsSet = URLSearchParamsCtor.prototype.set;
  const blobSize = getOwnPropertyDescriptor(BlobCtor.prototype, "size").get;
  const blobType = getOwnPropertyDescriptor(BlobCtor.prototype, "type").get;
  const responseOk = getOwnPropertyDescriptor(ResponseCtor.prototype, "ok").get;
  const responseStatus = getOwnPropertyDescriptor(ResponseCtor.prototype, "status").get;
  const responseUrl = getOwnPropertyDescriptor(ResponseCtor.prototype, "url").get;
  const responseHeaders = getOwnPropertyDescriptor(ResponseCtor.prototype, "headers").get;
  const responseBody = getOwnPropertyDescriptor(ResponseCtor.prototype, "body").get;
  const responseJson = ResponseCtor.prototype.json;
  const headersGet = HeadersCtor.prototype.get;
  const streamGetReader = ReadableStreamCtor.prototype.getReader;
  const readerRead = ReadableStreamDefaultReaderCtor.prototype.read;
  const readerCancel = ReadableStreamDefaultReaderCtor.prototype.cancel;
  const documentCreateElement = DocumentCtor.prototype.createElement;
  const anchorHref = getOwnPropertyDescriptor(HTMLAnchorElementCtor.prototype, "href");
  const anchorDownload = getOwnPropertyDescriptor(HTMLAnchorElementCtor.prototype, "download");
  const anchorClick = HTMLAnchorElementCtor.prototype.click;

  const required = [
    getOwnPropertyDescriptor, getPrototypeOf, defineProperty, freeze, isFrozen,
    apply, construct, nativeFetch, nativeSetTimeout, nativeClearTimeout,
    nativeEncodeURIComponent, nativeCreateObjectURL, nativeRevokeObjectURL,
    stringStartsWith, stringEndsWith, stringIncludes, stringSlice, stringSplit,
    stringTrim, stringToLowerCase, arrayIsArray, arrayPush, arrayJoin,
    numberIsSafeInteger, regexpTest, jsonStringify, mathMin, mapGet, mapSet,
    mapDelete, abortControllerAbort, abortControllerSignal, abortSignalAborted,
    uint8ByteLength, eventTargetAdd, eventTargetRemove, urlPathname.set,
    urlProtocol, urlHostname,
    urlSearchParams, urlToString, urlSearchParamsSet, blobSize, blobType,
    responseOk, responseStatus, responseUrl, responseHeaders, responseBody,
    responseJson, headersGet, streamGetReader, readerRead, readerCancel,
    documentCreateElement, anchorHref.set, anchorDownload.set, anchorClick
  ];
  for (let index = 0; index < required.length; index += 1) {
    if (typeof required[index] !== "function") return;
  }

  const call = (fn, receiver, args) => apply(fn, receiver, args);
  const make = (ctor, args) => construct(ctor, args);
  const registry = make(MapCtor, []);
  let api = null;
  api = {
    brand: "giv-native-primordials-v1",
    version: 1,
    validate: (candidate) => candidate === api && call(isFrozen, ObjectCtor, [api]),
    fetch: (...args) => call(nativeFetch, root, args),
    makeURL: (input, base) => base === undefined
      ? make(URLCtor, [input])
      : make(URLCtor, [input, base]),
    setURLPathname: (url, value) => call(urlPathname.set, url, [value]),
    setURLSearchParam: (url, name, value) => {
      const params = call(urlSearchParams, url, []);
      return call(urlSearchParamsSet, params, [name, value]);
    },
    urlToString: (url) => call(urlToString, url, []),
    urlProtocol: (url) => call(urlProtocol, url, []),
    urlHostname: (url) => call(urlHostname, url, []),
    makeBlob: (chunks, options) => make(BlobCtor, [chunks, options]),
    blobSize: (blob) => call(blobSize, blob, []),
    blobType: (blob) => call(blobType, blob, []),
    createObjectURL: (blob) => call(nativeCreateObjectURL, URLCtor, [blob]),
    revokeObjectURL: (url) => call(nativeRevokeObjectURL, URLCtor, [url]),
    beginOperation: (token) => {
      const controller = make(AbortControllerCtor, []);
      const entry = { controller, blobUrl: "" };
      call(mapSet, registry, [token, entry]);
      return entry;
    },
    getOperation: (token) => call(mapGet, registry, [token]),
    deleteOperation: (token) => call(mapDelete, registry, [token]),
    abortController: (controller) => call(abortControllerAbort, controller, []),
    abortSignal: (controller) => call(abortControllerSignal, controller, []),
    signalAborted: (signal) => call(abortSignalAborted, signal, []),
    signalAdd: (signal, type, listener, options) =>
      call(eventTargetAdd, signal, [type, listener, options]),
    signalRemove: (signal, type, listener) =>
      call(eventTargetRemove, signal, [type, listener]),
    isUint8Array: (value) => getPrototypeOf(value) === Uint8ArrayCtor.prototype,
    uint8ByteLength: (value) => call(uint8ByteLength, value, []),
    responseOk: (response) => call(responseOk, response, []),
    responseStatus: (response) => call(responseStatus, response, []),
    responseUrl: (response) => call(responseUrl, response, []),
    responseHeaders: (response) => call(responseHeaders, response, []),
    responseBody: (response) => call(responseBody, response, []),
    responseJson: (response) => call(responseJson, response, []),
    header: (headers, name) => call(headersGet, headers, [name]),
    streamReader: (stream) => call(streamGetReader, stream, []),
    readerRead: (reader) => call(readerRead, reader, []),
    readerCancel: (reader, reason) => call(readerCancel, reader, [reason]),
    makePromise: (executor) => make(PromiseCtor, [executor]),
    setTimer: (callback, milliseconds) =>
      call(nativeSetTimeout, root, [callback, milliseconds]),
    clearTimer: (timer) => call(nativeClearTimeout, root, [timer]),
    makeAbortError: () => make(DOMExceptionCtor, ["Aborted", "AbortError"]),
    createAnchor: () => {
      const anchor = call(documentCreateElement, documentValue, ["a"]);
      return getPrototypeOf(anchor) === HTMLAnchorElementCtor.prototype ? anchor : null;
    },
    setAnchorHref: (anchor, value) => call(anchorHref.set, anchor, [value]),
    setAnchorDownload: (anchor, value) => call(anchorDownload.set, anchor, [value]),
    clickAnchor: (anchor) => call(anchorClick, anchor, []),
    stringStartsWith: (value, search) => call(stringStartsWith, value, [search]),
    stringEndsWith: (value, search) => call(stringEndsWith, value, [search]),
    stringIncludes: (value, search) => call(stringIncludes, value, [search]),
    stringSlice: (value, start, end) => call(stringSlice, value, [start, end]),
    stringSplit: (value, separator) => call(stringSplit, value, [separator]),
    stringTrim: (value) => call(stringTrim, value, []),
    stringToLowerCase: (value) => call(stringToLowerCase, value, []),
    arrayIsArray: (value) => call(arrayIsArray, ArrayCtor, [value]),
    arrayPush: (array, value) => call(arrayPush, array, [value]),
    arrayJoin: (array, separator) => call(arrayJoin, array, [separator]),
    numberIsSafeInteger: (value) => call(numberIsSafeInteger, NumberCtor, [value]),
    toNumber: (value) => call(NumberCtor, undefined, [value]),
    regexpTest: (expression, value) => call(regexpTest, expression, [value]),
    jsonStringify: (value) => call(jsonStringify, JSON, [value]),
    min: (left, right) => call(mathMin, Math, [left, right]),
    encodeURIComponent: (value) => call(nativeEncodeURIComponent, root, [value])
  };
  call(freeze, ObjectCtor, [api]);
  call(defineProperty, ObjectCtor, [root, key, {
    value: api,
    enumerable: false,
    configurable: false,
    writable: false
  }]);
})()"#;

pub(crate) fn grok_primordials_initialization_script() -> &'static str {
    INITIALIZATION_SCRIPT
}

pub(super) fn fixed_expression(script: &str, input: &str) -> String {
    format!(
        "({script})({input}, (function () {{ return this; }})()[{key:?}])",
        key = PRIMORDIALS_GLOBAL
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_script_installs_a_frozen_non_replaceable_capture() {
        for required in [
            "nativeFetch",
            "URLCtor",
            "nativeCreateObjectURL",
            "nativeRevokeObjectURL",
            "BlobCtor",
            "MapCtor",
            "AbortControllerCtor",
            "Uint8ArrayCtor",
            "uint8ByteLength",
            "documentCreateElement",
            "anchorClick",
            "call(freeze, ObjectCtor, [api])",
            "configurable: false",
            "writable: false",
        ] {
            assert!(INITIALIZATION_SCRIPT.contains(required), "{required}");
        }
        for forbidden in [
            "__TAURI__",
            "invoke(",
            "document.cookie",
            "localStorage",
            "sessionStorage",
        ] {
            assert!(!INITIALIZATION_SCRIPT.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn fixed_expression_passes_only_the_captured_object_to_the_script() {
        let expression =
            fixed_expression("(input, primordials) => input + primordials.version", "1");
        assert!(expression.contains(PRIMORDIALS_GLOBAL));
        assert!(expression.contains("return this"));
        assert!(!expression.contains("window."));
    }
}
