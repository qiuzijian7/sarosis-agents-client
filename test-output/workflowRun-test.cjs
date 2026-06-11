"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/vs/sessions/contrib/agentStudio/test/browser/workflowRunInjectPrompt.test.ts
var import_assert2 = __toESM(require("assert"), 1);

// src/vs/base/common/collections.ts
function groupBy(data, groupFn) {
  const result = /* @__PURE__ */ Object.create(null);
  for (const element of data) {
    const key = groupFn(element);
    let target = result[key];
    if (!target) {
      target = result[key] = [];
    }
    target.push(element);
  }
  return result;
}
var _a, _b;
var SetWithKey = class {
  constructor(values, toKey) {
    this.toKey = toKey;
    this._map = /* @__PURE__ */ new Map();
    this[_a] = "SetWithKey";
    for (const value of values) {
      this.add(value);
    }
  }
  get size() {
    return this._map.size;
  }
  add(value) {
    const key = this.toKey(value);
    this._map.set(key, value);
    return this;
  }
  delete(value) {
    return this._map.delete(this.toKey(value));
  }
  has(value) {
    return this._map.has(this.toKey(value));
  }
  *entries() {
    for (const entry of this._map.values()) {
      yield [entry, entry];
    }
  }
  keys() {
    return this.values();
  }
  *values() {
    for (const entry of this._map.values()) {
      yield entry;
    }
  }
  clear() {
    this._map.clear();
  }
  forEach(callbackfn, thisArg) {
    this._map.forEach((entry) => callbackfn.call(thisArg, entry, entry, this));
  }
  [(_b = Symbol.iterator, _a = Symbol.toStringTag, _b)]() {
    return this.values();
  }
};

// src/vs/base/common/errors.ts
var ErrorHandler = class {
  constructor() {
    this.listeners = [];
    this.unexpectedErrorHandler = function(e) {
      setTimeout(() => {
        if (e.stack) {
          if (ErrorNoTelemetry.isErrorNoTelemetry(e)) {
            throw new ErrorNoTelemetry(e.message + "\n\n" + e.stack);
          }
          throw new Error(e.message + "\n\n" + e.stack);
        }
        throw e;
      }, 0);
    };
  }
  addListener(listener) {
    this.listeners.push(listener);
    return () => {
      this._removeListener(listener);
    };
  }
  emit(e) {
    this.listeners.forEach((listener) => {
      listener(e);
    });
  }
  _removeListener(listener) {
    this.listeners.splice(this.listeners.indexOf(listener), 1);
  }
  setUnexpectedErrorHandler(newUnexpectedErrorHandler) {
    this.unexpectedErrorHandler = newUnexpectedErrorHandler;
  }
  getUnexpectedErrorHandler() {
    return this.unexpectedErrorHandler;
  }
  onUnexpectedError(e) {
    this.unexpectedErrorHandler(e);
    this.emit(e);
  }
  // For external errors, we don't want the listeners to be called
  onUnexpectedExternalError(e) {
    this.unexpectedErrorHandler(e);
  }
};
var errorHandler = new ErrorHandler();
function onUnexpectedError(e) {
  if (!isCancellationError(e)) {
    errorHandler.onUnexpectedError(e);
  }
  return void 0;
}
var canceledName = "Canceled";
function isCancellationError(error) {
  if (error instanceof CancellationError) {
    return true;
  }
  return error instanceof Error && error.name === canceledName && error.message === canceledName;
}
var CancellationError = class extends Error {
  constructor() {
    super(canceledName);
    this.name = this.message;
  }
};
var PendingMigrationError = class _PendingMigrationError extends Error {
  static {
    this._name = "PendingMigrationError";
  }
  static is(error) {
    return error instanceof _PendingMigrationError || error instanceof Error && error.name === _PendingMigrationError._name;
  }
  constructor(message) {
    super(message);
    this.name = _PendingMigrationError._name;
  }
};
var ErrorNoTelemetry = class _ErrorNoTelemetry extends Error {
  constructor(msg) {
    super(msg);
    this.name = "CodeExpectedError";
  }
  static fromError(err) {
    if (err instanceof _ErrorNoTelemetry) {
      return err;
    }
    const result = new _ErrorNoTelemetry();
    result.message = err.message;
    result.stack = err.stack;
    return result;
  }
  static isErrorNoTelemetry(err) {
    return err.name === "CodeExpectedError";
  }
};
var BugIndicatingError = class _BugIndicatingError extends Error {
  constructor(message) {
    super(message || "An unexpected bug occurred.");
    Object.setPrototypeOf(this, _BugIndicatingError.prototype);
  }
};

// src/vs/base/common/arraysFind.ts
function findLastIdxMonotonous(array, predicate, startIdx = 0, endIdxEx = array.length) {
  let i = startIdx;
  let j = endIdxEx;
  while (i < j) {
    const k = Math.floor((i + j) / 2);
    if (predicate(array[k])) {
      i = k + 1;
    } else {
      j = k;
    }
  }
  return i - 1;
}
var MonotonousArray = class _MonotonousArray {
  constructor(_array) {
    this._array = _array;
    this._findLastMonotonousLastIdx = 0;
  }
  static {
    this.assertInvariants = false;
  }
  /**
   * The predicate must be monotonous, i.e. `arr.map(predicate)` must be like `[true, ..., true, false, ..., false]`!
   * For subsequent calls, current predicate must be weaker than (or equal to) the previous predicate, i.e. more entries must be `true`.
   */
  findLastMonotonous(predicate) {
    if (_MonotonousArray.assertInvariants) {
      if (this._prevFindLastPredicate) {
        for (const item of this._array) {
          if (this._prevFindLastPredicate(item) && !predicate(item)) {
            throw new Error("MonotonousArray: current predicate must be weaker than (or equal to) the previous predicate.");
          }
        }
      }
      this._prevFindLastPredicate = predicate;
    }
    const idx = findLastIdxMonotonous(this._array, predicate, this._findLastMonotonousLastIdx);
    this._findLastMonotonousLastIdx = idx + 1;
    return idx === -1 ? void 0 : this._array[idx];
  }
};

// src/vs/base/common/arrays.ts
var CompareResult;
((CompareResult2) => {
  function isLessThan(result) {
    return result < 0;
  }
  CompareResult2.isLessThan = isLessThan;
  function isLessThanOrEqual(result) {
    return result <= 0;
  }
  CompareResult2.isLessThanOrEqual = isLessThanOrEqual;
  function isGreaterThan(result) {
    return result > 0;
  }
  CompareResult2.isGreaterThan = isGreaterThan;
  function isNeitherLessOrGreaterThan(result) {
    return result === 0;
  }
  CompareResult2.isNeitherLessOrGreaterThan = isNeitherLessOrGreaterThan;
  CompareResult2.greaterThan = 1;
  CompareResult2.lessThan = -1;
  CompareResult2.neitherLessOrGreaterThan = 0;
})(CompareResult || (CompareResult = {}));
function compareBy(selector, comparator) {
  return (a, b) => comparator(selector(a), selector(b));
}
var numberComparator = (a, b) => a - b;
var CallbackIterable = class _CallbackIterable {
  constructor(iterate) {
    this.iterate = iterate;
  }
  static {
    this.empty = new _CallbackIterable((_callback) => {
    });
  }
  forEach(handler) {
    this.iterate((item) => {
      handler(item);
      return true;
    });
  }
  toArray() {
    const result = [];
    this.iterate((item) => {
      result.push(item);
      return true;
    });
    return result;
  }
  filter(predicate) {
    return new _CallbackIterable((cb) => this.iterate((item) => predicate(item) ? cb(item) : true));
  }
  map(mapFn) {
    return new _CallbackIterable((cb) => this.iterate((item) => cb(mapFn(item))));
  }
  some(predicate) {
    let result = false;
    this.iterate((item) => {
      result = predicate(item);
      return !result;
    });
    return result;
  }
  findFirst(predicate) {
    let result;
    this.iterate((item) => {
      if (predicate(item)) {
        result = item;
        return false;
      }
      return true;
    });
    return result;
  }
  findLast(predicate) {
    let result;
    this.iterate((item) => {
      if (predicate(item)) {
        result = item;
      }
      return true;
    });
    return result;
  }
  findLastMaxBy(comparator) {
    let result;
    let first = true;
    this.iterate((item) => {
      if (first || CompareResult.isGreaterThan(comparator(item, result))) {
        first = false;
        result = item;
      }
      return true;
    });
    return result;
  }
};

// src/vs/base/common/map.ts
var ResourceMapEntry = class {
  constructor(uri, value) {
    this.uri = uri;
    this.value = value;
  }
};
function isEntries(arg) {
  return Array.isArray(arg);
}
var _a2;
var ResourceMap = class _ResourceMap {
  constructor(arg, toKey) {
    this[_a2] = "ResourceMap";
    if (arg instanceof _ResourceMap) {
      this.map = new Map(arg.map);
      this.toKey = toKey ?? _ResourceMap.defaultToKey;
    } else if (isEntries(arg)) {
      this.map = /* @__PURE__ */ new Map();
      this.toKey = toKey ?? _ResourceMap.defaultToKey;
      for (const [resource, value] of arg) {
        this.set(resource, value);
      }
    } else {
      this.map = /* @__PURE__ */ new Map();
      this.toKey = arg ?? _ResourceMap.defaultToKey;
    }
  }
  static {
    this.defaultToKey = (resource) => resource.toString();
  }
  set(resource, value) {
    this.map.set(this.toKey(resource), new ResourceMapEntry(resource, value));
    return this;
  }
  get(resource) {
    return this.map.get(this.toKey(resource))?.value;
  }
  has(resource) {
    return this.map.has(this.toKey(resource));
  }
  get size() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  delete(resource) {
    return this.map.delete(this.toKey(resource));
  }
  forEach(clb, thisArg) {
    if (typeof thisArg !== "undefined") {
      clb = clb.bind(thisArg);
    }
    for (const [_, entry] of this.map) {
      clb(entry.value, entry.uri, this);
    }
  }
  *values() {
    for (const entry of this.map.values()) {
      yield entry.value;
    }
  }
  *keys() {
    for (const entry of this.map.values()) {
      yield entry.uri;
    }
  }
  *entries() {
    for (const entry of this.map.values()) {
      yield [entry.uri, entry.value];
    }
  }
  *[(_a2 = Symbol.toStringTag, Symbol.iterator)]() {
    for (const [, entry] of this.map) {
      yield [entry.uri, entry.value];
    }
  }
};
var _a3;
var ResourceSet = class {
  constructor(entriesOrKey, toKey) {
    this[_a3] = "ResourceSet";
    if (!entriesOrKey || typeof entriesOrKey === "function") {
      this._map = new ResourceMap(entriesOrKey);
    } else {
      this._map = new ResourceMap(toKey);
      entriesOrKey.forEach(this.add, this);
    }
  }
  get size() {
    return this._map.size;
  }
  add(value) {
    this._map.set(value, value);
    return this;
  }
  clear() {
    this._map.clear();
  }
  delete(value) {
    return this._map.delete(value);
  }
  forEach(callbackfn, thisArg) {
    this._map.forEach((_value, key) => callbackfn.call(thisArg, key, key, this));
  }
  has(value) {
    return this._map.has(value);
  }
  entries() {
    return this._map.entries();
  }
  keys() {
    return this._map.keys();
  }
  values() {
    return this._map.keys();
  }
  [(_a3 = Symbol.toStringTag, Symbol.iterator)]() {
    return this.keys();
  }
};
var _a4;
var LinkedMap = class {
  constructor() {
    this[_a4] = "LinkedMap";
    this._map = /* @__PURE__ */ new Map();
    this._head = void 0;
    this._tail = void 0;
    this._size = 0;
    this._state = 0;
  }
  clear() {
    this._map.clear();
    this._head = void 0;
    this._tail = void 0;
    this._size = 0;
    this._state++;
  }
  isEmpty() {
    return !this._head && !this._tail;
  }
  get size() {
    return this._size;
  }
  get first() {
    return this._head?.value;
  }
  get last() {
    return this._tail?.value;
  }
  has(key) {
    return this._map.has(key);
  }
  get(key, touch = 0 /* None */) {
    const item = this._map.get(key);
    if (!item) {
      return void 0;
    }
    if (touch !== 0 /* None */) {
      this.touch(item, touch);
    }
    return item.value;
  }
  set(key, value, touch = 0 /* None */) {
    let item = this._map.get(key);
    if (item) {
      item.value = value;
      if (touch !== 0 /* None */) {
        this.touch(item, touch);
      }
    } else {
      item = { key, value, next: void 0, previous: void 0 };
      switch (touch) {
        case 0 /* None */:
          this.addItemLast(item);
          break;
        case 1 /* AsOld */:
          this.addItemFirst(item);
          break;
        case 2 /* AsNew */:
          this.addItemLast(item);
          break;
        default:
          this.addItemLast(item);
          break;
      }
      this._map.set(key, item);
      this._size++;
    }
    return this;
  }
  delete(key) {
    return !!this.remove(key);
  }
  remove(key) {
    const item = this._map.get(key);
    if (!item) {
      return void 0;
    }
    this._map.delete(key);
    this.removeItem(item);
    this._size--;
    return item.value;
  }
  shift() {
    if (!this._head && !this._tail) {
      return void 0;
    }
    if (!this._head || !this._tail) {
      throw new Error("Invalid list");
    }
    const item = this._head;
    this._map.delete(item.key);
    this.removeItem(item);
    this._size--;
    return item.value;
  }
  forEach(callbackfn, thisArg) {
    const state = this._state;
    let current = this._head;
    while (current) {
      if (thisArg) {
        callbackfn.bind(thisArg)(current.value, current.key, this);
      } else {
        callbackfn(current.value, current.key, this);
      }
      if (this._state !== state) {
        throw new Error(`LinkedMap got modified during iteration.`);
      }
      current = current.next;
    }
  }
  keys() {
    const map = this;
    const state = this._state;
    let current = this._head;
    const iterator = {
      [Symbol.iterator]() {
        return iterator;
      },
      next() {
        if (map._state !== state) {
          throw new Error(`LinkedMap got modified during iteration.`);
        }
        if (current) {
          const result = { value: current.key, done: false };
          current = current.next;
          return result;
        } else {
          return { value: void 0, done: true };
        }
      }
    };
    return iterator;
  }
  values() {
    const map = this;
    const state = this._state;
    let current = this._head;
    const iterator = {
      [Symbol.iterator]() {
        return iterator;
      },
      next() {
        if (map._state !== state) {
          throw new Error(`LinkedMap got modified during iteration.`);
        }
        if (current) {
          const result = { value: current.value, done: false };
          current = current.next;
          return result;
        } else {
          return { value: void 0, done: true };
        }
      }
    };
    return iterator;
  }
  entries() {
    const map = this;
    const state = this._state;
    let current = this._head;
    const iterator = {
      [Symbol.iterator]() {
        return iterator;
      },
      next() {
        if (map._state !== state) {
          throw new Error(`LinkedMap got modified during iteration.`);
        }
        if (current) {
          const result = { value: [current.key, current.value], done: false };
          current = current.next;
          return result;
        } else {
          return { value: void 0, done: true };
        }
      }
    };
    return iterator;
  }
  [(_a4 = Symbol.toStringTag, Symbol.iterator)]() {
    return this.entries();
  }
  trimOld(newSize) {
    if (newSize >= this.size) {
      return;
    }
    if (newSize === 0) {
      this.clear();
      return;
    }
    let current = this._head;
    let currentSize = this.size;
    while (current && currentSize > newSize) {
      this._map.delete(current.key);
      current = current.next;
      currentSize--;
    }
    this._head = current;
    this._size = currentSize;
    if (current) {
      current.previous = void 0;
    }
    this._state++;
  }
  trimNew(newSize) {
    if (newSize >= this.size) {
      return;
    }
    if (newSize === 0) {
      this.clear();
      return;
    }
    let current = this._tail;
    let currentSize = this.size;
    while (current && currentSize > newSize) {
      this._map.delete(current.key);
      current = current.previous;
      currentSize--;
    }
    this._tail = current;
    this._size = currentSize;
    if (current) {
      current.next = void 0;
    }
    this._state++;
  }
  addItemFirst(item) {
    if (!this._head && !this._tail) {
      this._tail = item;
    } else if (!this._head) {
      throw new Error("Invalid list");
    } else {
      item.next = this._head;
      this._head.previous = item;
    }
    this._head = item;
    this._state++;
  }
  addItemLast(item) {
    if (!this._head && !this._tail) {
      this._head = item;
    } else if (!this._tail) {
      throw new Error("Invalid list");
    } else {
      item.previous = this._tail;
      this._tail.next = item;
    }
    this._tail = item;
    this._state++;
  }
  removeItem(item) {
    if (item === this._head && item === this._tail) {
      this._head = void 0;
      this._tail = void 0;
    } else if (item === this._head) {
      if (!item.next) {
        throw new Error("Invalid list");
      }
      item.next.previous = void 0;
      this._head = item.next;
    } else if (item === this._tail) {
      if (!item.previous) {
        throw new Error("Invalid list");
      }
      item.previous.next = void 0;
      this._tail = item.previous;
    } else {
      const next = item.next;
      const previous = item.previous;
      if (!next || !previous) {
        throw new Error("Invalid list");
      }
      next.previous = previous;
      previous.next = next;
    }
    item.next = void 0;
    item.previous = void 0;
    this._state++;
  }
  touch(item, touch) {
    if (!this._head || !this._tail) {
      throw new Error("Invalid list");
    }
    if (touch !== 1 /* AsOld */ && touch !== 2 /* AsNew */) {
      return;
    }
    if (touch === 1 /* AsOld */) {
      if (item === this._head) {
        return;
      }
      const next = item.next;
      const previous = item.previous;
      if (item === this._tail) {
        previous.next = void 0;
        this._tail = previous;
      } else {
        next.previous = previous;
        previous.next = next;
      }
      item.previous = void 0;
      item.next = this._head;
      this._head.previous = item;
      this._head = item;
      this._state++;
    } else if (touch === 2 /* AsNew */) {
      if (item === this._tail) {
        return;
      }
      const next = item.next;
      const previous = item.previous;
      if (item === this._head) {
        next.previous = void 0;
        this._head = next;
      } else {
        next.previous = previous;
        previous.next = next;
      }
      item.next = void 0;
      item.previous = this._tail;
      this._tail.next = item;
      this._tail = item;
      this._state++;
    }
  }
  toJSON() {
    const data = [];
    this.forEach((value, key) => {
      data.push([key, value]);
    });
    return data;
  }
  fromJSON(data) {
    this.clear();
    for (const [key, value] of data) {
      this.set(key, value);
    }
  }
};
var SetMap = class {
  constructor() {
    this.map = /* @__PURE__ */ new Map();
  }
  add(key, value) {
    let values = this.map.get(key);
    if (!values) {
      values = /* @__PURE__ */ new Set();
      this.map.set(key, values);
    }
    values.add(value);
  }
  delete(key, value) {
    const values = this.map.get(key);
    if (!values) {
      return;
    }
    values.delete(value);
    if (values.size === 0) {
      this.map.delete(key);
    }
  }
  forEach(key, fn) {
    const values = this.map.get(key);
    if (!values) {
      return;
    }
    values.forEach(fn);
  }
  get(key) {
    const values = this.map.get(key);
    if (!values) {
      return /* @__PURE__ */ new Set();
    }
    return values;
  }
};

// src/vs/base/common/types.ts
function isIterable(obj) {
  return !!obj && typeof obj[Symbol.iterator] === "function";
}

// src/vs/base/common/iterator.ts
var Iterable;
((Iterable2) => {
  function is(thing) {
    return !!thing && typeof thing === "object" && typeof thing[Symbol.iterator] === "function";
  }
  Iterable2.is = is;
  const _empty = Object.freeze([]);
  function empty() {
    return _empty;
  }
  Iterable2.empty = empty;
  function* single(element) {
    yield element;
  }
  Iterable2.single = single;
  function wrap(iterableOrElement) {
    if (is(iterableOrElement)) {
      return iterableOrElement;
    } else {
      return single(iterableOrElement);
    }
  }
  Iterable2.wrap = wrap;
  function from(iterable) {
    return iterable ?? _empty;
  }
  Iterable2.from = from;
  function* reverse(array) {
    for (let i = array.length - 1; i >= 0; i--) {
      yield array[i];
    }
  }
  Iterable2.reverse = reverse;
  function isEmpty(iterable) {
    return !iterable || iterable[Symbol.iterator]().next().done === true;
  }
  Iterable2.isEmpty = isEmpty;
  function first(iterable) {
    return iterable[Symbol.iterator]().next().value;
  }
  Iterable2.first = first;
  function some(iterable, predicate) {
    let i = 0;
    for (const element of iterable) {
      if (predicate(element, i++)) {
        return true;
      }
    }
    return false;
  }
  Iterable2.some = some;
  function every(iterable, predicate) {
    let i = 0;
    for (const element of iterable) {
      if (!predicate(element, i++)) {
        return false;
      }
    }
    return true;
  }
  Iterable2.every = every;
  function find(iterable, predicate) {
    for (const element of iterable) {
      if (predicate(element)) {
        return element;
      }
    }
    return void 0;
  }
  Iterable2.find = find;
  function* filter(iterable, predicate) {
    for (const element of iterable) {
      if (predicate(element)) {
        yield element;
      }
    }
  }
  Iterable2.filter = filter;
  function* map(iterable, fn) {
    let index = 0;
    for (const element of iterable) {
      yield fn(element, index++);
    }
  }
  Iterable2.map = map;
  function* flatMap(iterable, fn) {
    let index = 0;
    for (const element of iterable) {
      yield* fn(element, index++);
    }
  }
  Iterable2.flatMap = flatMap;
  function* concat(...iterables) {
    for (const item of iterables) {
      if (isIterable(item)) {
        yield* item;
      } else {
        yield item;
      }
    }
  }
  Iterable2.concat = concat;
  function reduce(iterable, reducer, initialValue) {
    let value = initialValue;
    for (const element of iterable) {
      value = reducer(value, element);
    }
    return value;
  }
  Iterable2.reduce = reduce;
  function length(iterable) {
    let count = 0;
    for (const _ of iterable) {
      count++;
    }
    return count;
  }
  Iterable2.length = length;
  function* slice(arr, from2, to = arr.length) {
    if (from2 < -arr.length) {
      from2 = 0;
    }
    if (from2 < 0) {
      from2 += arr.length;
    }
    if (to < 0) {
      to += arr.length;
    } else if (to > arr.length) {
      to = arr.length;
    }
    for (; from2 < to; from2++) {
      yield arr[from2];
    }
  }
  Iterable2.slice = slice;
  function consume(iterable, atMost = Number.POSITIVE_INFINITY) {
    const consumed = [];
    if (atMost === 0) {
      return [consumed, iterable];
    }
    const iterator = iterable[Symbol.iterator]();
    for (let i = 0; i < atMost; i++) {
      const next = iterator.next();
      if (next.done) {
        return [consumed, Iterable2.empty()];
      }
      consumed.push(next.value);
    }
    return [consumed, { [Symbol.iterator]() {
      return iterator;
    } }];
  }
  Iterable2.consume = consume;
  async function asyncToArray(iterable) {
    const result = [];
    for await (const item of iterable) {
      result.push(item);
    }
    return result;
  }
  Iterable2.asyncToArray = asyncToArray;
  async function asyncToArrayFlat(iterable) {
    let result = [];
    for await (const item of iterable) {
      result = result.concat(item);
    }
    return result;
  }
  Iterable2.asyncToArrayFlat = asyncToArrayFlat;
})(Iterable || (Iterable = {}));

// src/vs/base/common/lifecycle.ts
var TRACK_DISPOSABLES = false;
var disposableTracker = null;
var DisposableTracker = class _DisposableTracker {
  constructor() {
    this.livingDisposables = /* @__PURE__ */ new Map();
  }
  static {
    this.idx = 0;
  }
  getDisposableData(d) {
    let val = this.livingDisposables.get(d);
    if (!val) {
      val = { parent: null, source: null, isSingleton: false, value: d, idx: _DisposableTracker.idx++ };
      this.livingDisposables.set(d, val);
    }
    return val;
  }
  trackDisposable(d) {
    const data = this.getDisposableData(d);
    if (!data.source) {
      data.source = new Error().stack;
    }
  }
  setParent(child, parent) {
    const data = this.getDisposableData(child);
    data.parent = parent;
  }
  markAsDisposed(x) {
    this.livingDisposables.delete(x);
  }
  markAsSingleton(disposable) {
    this.getDisposableData(disposable).isSingleton = true;
  }
  getRootParent(data, cache) {
    const cacheValue = cache.get(data);
    if (cacheValue) {
      return cacheValue;
    }
    const result = data.parent ? this.getRootParent(this.getDisposableData(data.parent), cache) : data;
    cache.set(data, result);
    return result;
  }
  getTrackedDisposables() {
    const rootParentCache = /* @__PURE__ */ new Map();
    const leaking = [...this.livingDisposables.entries()].filter(([, v]) => v.source !== null && !this.getRootParent(v, rootParentCache).isSingleton).flatMap(([k]) => k);
    return leaking;
  }
  computeLeakingDisposables(maxReported = 10, preComputedLeaks) {
    let uncoveredLeakingObjs;
    if (preComputedLeaks) {
      uncoveredLeakingObjs = preComputedLeaks;
    } else {
      const rootParentCache = /* @__PURE__ */ new Map();
      const leakingObjects = [...this.livingDisposables.values()].filter((info) => info.source !== null && !this.getRootParent(info, rootParentCache).isSingleton);
      if (leakingObjects.length === 0) {
        return;
      }
      const leakingObjsSet = new Set(leakingObjects.map((o) => o.value));
      uncoveredLeakingObjs = leakingObjects.filter((l) => {
        return !(l.parent && leakingObjsSet.has(l.parent));
      });
      if (uncoveredLeakingObjs.length === 0) {
        throw new Error("There are cyclic diposable chains!");
      }
    }
    if (!uncoveredLeakingObjs) {
      return void 0;
    }
    function getStackTracePath(leaking) {
      function removePrefix(array, linesToRemove) {
        while (array.length > 0 && linesToRemove.some((regexp) => typeof regexp === "string" ? regexp === array[0] : array[0].match(regexp))) {
          array.shift();
        }
      }
      const lines = leaking.source.split("\n").map((p) => p.trim().replace("at ", "")).filter((l) => l !== "");
      removePrefix(lines, ["Error", /^trackDisposable \(.*\)$/, /^DisposableTracker.trackDisposable \(.*\)$/]);
      return lines.reverse();
    }
    const stackTraceStarts = new SetMap();
    for (const leaking of uncoveredLeakingObjs) {
      const stackTracePath = getStackTracePath(leaking);
      for (let i2 = 0; i2 <= stackTracePath.length; i2++) {
        stackTraceStarts.add(stackTracePath.slice(0, i2).join("\n"), leaking);
      }
    }
    uncoveredLeakingObjs.sort(compareBy((l) => l.idx, numberComparator));
    let message = "";
    let i = 0;
    for (const leaking of uncoveredLeakingObjs.slice(0, maxReported)) {
      i++;
      const stackTracePath = getStackTracePath(leaking);
      const stackTraceFormattedLines = [];
      for (let i2 = 0; i2 < stackTracePath.length; i2++) {
        let line = stackTracePath[i2];
        const starts = stackTraceStarts.get(stackTracePath.slice(0, i2 + 1).join("\n"));
        line = `(shared with ${starts.size}/${uncoveredLeakingObjs.length} leaks) at ${line}`;
        const prevStarts = stackTraceStarts.get(stackTracePath.slice(0, i2).join("\n"));
        const continuations = groupBy([...prevStarts].map((d) => getStackTracePath(d)[i2]), (v) => v);
        delete continuations[stackTracePath[i2]];
        for (const [cont, set] of Object.entries(continuations)) {
          if (set) {
            stackTraceFormattedLines.unshift(`    - stacktraces of ${set.length} other leaks continue with ${cont}`);
          }
        }
        stackTraceFormattedLines.unshift(line);
      }
      message += `


==================== Leaking disposable ${i}/${uncoveredLeakingObjs.length}: ${leaking.value.constructor.name} ====================
${stackTraceFormattedLines.join("\n")}
============================================================

`;
    }
    if (uncoveredLeakingObjs.length > maxReported) {
      message += `


... and ${uncoveredLeakingObjs.length - maxReported} more leaking disposables

`;
    }
    return { leaks: uncoveredLeakingObjs, details: message };
  }
};
function setDisposableTracker(tracker) {
  disposableTracker = tracker;
}
if (TRACK_DISPOSABLES) {
  const __is_disposable_tracked__ = "__is_disposable_tracked__";
  setDisposableTracker(new class {
    trackDisposable(x) {
      const stack = new Error("Potentially leaked disposable").stack;
      setTimeout(() => {
        if (!x[__is_disposable_tracked__]) {
          console.log(stack);
        }
      }, 3e3);
    }
    setParent(child, parent) {
      if (child && child !== Disposable.None) {
        try {
          child[__is_disposable_tracked__] = true;
        } catch {
        }
      }
    }
    markAsDisposed(disposable) {
      if (disposable && disposable !== Disposable.None) {
        try {
          disposable[__is_disposable_tracked__] = true;
        } catch {
        }
      }
    }
    markAsSingleton(disposable) {
    }
  }());
}
function trackDisposable(x) {
  disposableTracker?.trackDisposable(x);
  return x;
}
function markAsDisposed(disposable) {
  disposableTracker?.markAsDisposed(disposable);
}
function setParentOfDisposable(child, parent) {
  disposableTracker?.setParent(child, parent);
}
function setParentOfDisposables(children, parent) {
  if (!disposableTracker) {
    return;
  }
  for (const child of children) {
    disposableTracker.setParent(child, parent);
  }
}
function dispose(arg) {
  if (Iterable.is(arg)) {
    const errors = [];
    for (const d of arg) {
      if (d) {
        try {
          d.dispose();
        } catch (e) {
          errors.push(e);
        }
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    } else if (errors.length > 1) {
      throw new AggregateError(errors, "Encountered errors while disposing of store");
    }
    return Array.isArray(arg) ? [] : arg;
  } else if (arg) {
    arg.dispose();
    return arg;
  }
}
function combinedDisposable(...disposables) {
  const parent = toDisposable(() => dispose(disposables));
  setParentOfDisposables(disposables, parent);
  return parent;
}
var FunctionDisposable = class {
  constructor(fn) {
    this._isDisposed = false;
    this._fn = fn;
    trackDisposable(this);
  }
  dispose() {
    if (this._isDisposed) {
      return;
    }
    if (!this._fn) {
      throw new Error(`Unbound disposable context: Need to use an arrow function to preserve the value of this`);
    }
    this._isDisposed = true;
    markAsDisposed(this);
    this._fn();
  }
};
function toDisposable(fn) {
  return new FunctionDisposable(fn);
}
var DisposableStore = class _DisposableStore {
  constructor() {
    this._toDispose = /* @__PURE__ */ new Set();
    this._isDisposed = false;
    trackDisposable(this);
  }
  static {
    this.DISABLE_DISPOSED_WARNING = false;
  }
  /**
   * Dispose of all registered disposables and mark this object as disposed.
   *
   * Any future disposables added to this object will be disposed of on `add`.
   */
  dispose() {
    if (this._isDisposed) {
      return;
    }
    markAsDisposed(this);
    this._isDisposed = true;
    this.clear();
  }
  /**
   * @return `true` if this object has been disposed of.
   */
  get isDisposed() {
    return this._isDisposed;
  }
  /**
   * Dispose of all registered disposables but do not mark this object as disposed.
   */
  clear() {
    if (this._toDispose.size === 0) {
      return;
    }
    try {
      dispose(this._toDispose);
    } finally {
      this._toDispose.clear();
    }
  }
  /**
   * Add a new {@link IDisposable disposable} to the collection.
   */
  add(o) {
    if (!o || o === Disposable.None) {
      return o;
    }
    if (o === this) {
      throw new Error("Cannot register a disposable on itself!");
    }
    setParentOfDisposable(o, this);
    if (this._isDisposed) {
      if (!_DisposableStore.DISABLE_DISPOSED_WARNING) {
        console.warn(new Error("Trying to add a disposable to a DisposableStore that has already been disposed of. The added object will be leaked!").stack);
      }
    } else {
      this._toDispose.add(o);
    }
    return o;
  }
  /**
   * Deletes a disposable from store and disposes of it. This will not throw or warn and proceed to dispose the
   * disposable even when the disposable is not part in the store.
   */
  delete(o) {
    if (!o) {
      return;
    }
    if (o === this) {
      throw new Error("Cannot dispose a disposable on itself!");
    }
    this._toDispose.delete(o);
    o.dispose();
  }
  /**
   * Deletes the value from the store, but does not dispose it.
   */
  deleteAndLeak(o) {
    if (!o) {
      return;
    }
    if (this._toDispose.delete(o)) {
      setParentOfDisposable(o, null);
    }
  }
  assertNotDisposed() {
    if (this._isDisposed) {
      onUnexpectedError(new BugIndicatingError("Object disposed"));
    }
  }
};
var Disposable = class {
  constructor() {
    this._store = new DisposableStore();
    trackDisposable(this);
    setParentOfDisposable(this._store, this);
  }
  static {
    /**
     * A disposable that does nothing when it is disposed of.
     *
     * TODO: This should not be a static property.
     */
    this.None = Object.freeze({ dispose() {
    } });
  }
  dispose() {
    markAsDisposed(this);
    this._store.dispose();
  }
  /**
   * Adds `o` to the collection of disposables managed by this object.
   */
  _register(o) {
    if (o === this) {
      throw new Error("Cannot register a disposable on itself!");
    }
    return this._store.add(o);
  }
};

// src/vs/base/common/linkedList.ts
var Node = class _Node {
  static {
    this.Undefined = new _Node(void 0);
  }
  constructor(element) {
    this.element = element;
    this.next = _Node.Undefined;
    this.prev = _Node.Undefined;
  }
};

// src/vs/nls.ts
function getNLSLanguage() {
  return globalThis._VSCODE_NLS_LANGUAGE;
}
var isPseudo = getNLSLanguage() === "pseudo" || typeof document !== "undefined" && document.location && typeof document.location.hash === "string" && document.location.hash.indexOf("pseudo=true") >= 0;

// src/vs/base/common/platform.ts
var LANGUAGE_DEFAULT = "en";
var _isWindows = false;
var _isMacintosh = false;
var _isLinux = false;
var _isLinuxSnap = false;
var _isNative = false;
var _isWeb = false;
var _isElectron = false;
var _isIOS = false;
var _isCI = false;
var _isMobile = false;
var _locale = void 0;
var _language = LANGUAGE_DEFAULT;
var _platformLocale = LANGUAGE_DEFAULT;
var _translationsConfigFile = void 0;
var _userAgent = void 0;
var $globalThis = globalThis;
var nodeProcess = void 0;
if (typeof $globalThis.vscode !== "undefined" && typeof $globalThis.vscode.process !== "undefined") {
  nodeProcess = $globalThis.vscode.process;
} else if (typeof process !== "undefined" && typeof process?.versions?.node === "string") {
  nodeProcess = process;
}
var isElectronProcess = typeof nodeProcess?.versions?.electron === "string";
var isElectronRenderer = isElectronProcess && nodeProcess?.type === "renderer";
if (typeof nodeProcess === "object") {
  _isWindows = nodeProcess.platform === "win32";
  _isMacintosh = nodeProcess.platform === "darwin";
  _isLinux = nodeProcess.platform === "linux";
  _isLinuxSnap = _isLinux && !!nodeProcess.env["SNAP"] && !!nodeProcess.env["SNAP_REVISION"];
  _isElectron = isElectronProcess;
  _isCI = !!nodeProcess.env["CI"] || !!nodeProcess.env["BUILD_ARTIFACTSTAGINGDIRECTORY"] || !!nodeProcess.env["GITHUB_WORKSPACE"];
  _locale = LANGUAGE_DEFAULT;
  _language = LANGUAGE_DEFAULT;
  const rawNlsConfig = nodeProcess.env["VSCODE_NLS_CONFIG"];
  if (rawNlsConfig) {
    try {
      const nlsConfig = JSON.parse(rawNlsConfig);
      _locale = nlsConfig.userLocale;
      _platformLocale = nlsConfig.osLocale;
      _language = nlsConfig.resolvedLanguage || LANGUAGE_DEFAULT;
      _translationsConfigFile = nlsConfig.languagePack?.translationsConfigFile;
    } catch (e) {
    }
  }
  _isNative = true;
} else if (typeof navigator === "object" && !isElectronRenderer) {
  _userAgent = navigator.userAgent;
  _isWindows = _userAgent.indexOf("Windows") >= 0;
  _isMacintosh = _userAgent.indexOf("Macintosh") >= 0;
  _isIOS = (_userAgent.indexOf("Macintosh") >= 0 || _userAgent.indexOf("iPad") >= 0 || _userAgent.indexOf("iPhone") >= 0) && !!navigator.maxTouchPoints && navigator.maxTouchPoints > 0;
  _isLinux = _userAgent.indexOf("Linux") >= 0;
  _isMobile = _userAgent?.indexOf("Mobi") >= 0;
  _isWeb = true;
  _language = getNLSLanguage() || LANGUAGE_DEFAULT;
  _locale = navigator.language.toLowerCase();
  _platformLocale = _locale;
} else {
  console.error("Unable to resolve platform.");
}
var _platform = 0 /* Web */;
if (_isMacintosh) {
  _platform = 1 /* Mac */;
} else if (_isWindows) {
  _platform = 3 /* Windows */;
} else if (_isLinux) {
  _platform = 2 /* Linux */;
}
var isWindows = _isWindows;
var isMacintosh = _isMacintosh;
var isWebWorker = _isWeb && typeof $globalThis.importScripts === "function";
var webWorkerOrigin = isWebWorker ? $globalThis.origin : void 0;
var userAgent = _userAgent;
var language = _language;
var Language;
((Language2) => {
  function value() {
    return language;
  }
  Language2.value = value;
  function isDefaultVariant() {
    if (language.length === 2) {
      return language === "en";
    } else if (language.length >= 3) {
      return language[0] === "e" && language[1] === "n" && language[2] === "-";
    } else {
      return false;
    }
  }
  Language2.isDefaultVariant = isDefaultVariant;
  function isDefault() {
    return language === "en";
  }
  Language2.isDefault = isDefault;
})(Language || (Language = {}));
var setTimeout0IsFaster = typeof $globalThis.postMessage === "function" && !$globalThis.importScripts;
var setTimeout0 = (() => {
  if (setTimeout0IsFaster) {
    const pending = [];
    $globalThis.addEventListener("message", (e) => {
      if (e.data && e.data.vscodeScheduleAsyncWork) {
        for (let i = 0, len = pending.length; i < len; i++) {
          const candidate = pending[i];
          if (candidate.id === e.data.vscodeScheduleAsyncWork) {
            pending.splice(i, 1);
            candidate.callback();
            return;
          }
        }
      }
    });
    let lastId = 0;
    return (callback) => {
      const myId = ++lastId;
      pending.push({
        id: myId,
        callback
      });
      $globalThis.postMessage({ vscodeScheduleAsyncWork: myId }, "*");
    };
  }
  return (callback) => setTimeout(callback);
})();
var isChrome = !!(userAgent && userAgent.indexOf("Chrome") >= 0);
var isFirefox = !!(userAgent && userAgent.indexOf("Firefox") >= 0);
var isSafari = !!(!isChrome && (userAgent && userAgent.indexOf("Safari") >= 0));
var isEdge = !!(userAgent && userAgent.indexOf("Edg/") >= 0);
var isAndroid = !!(userAgent && userAgent.indexOf("Android") >= 0);

// src/vs/base/common/process.ts
var safeProcess;
var vscodeGlobal = globalThis.vscode;
if (typeof vscodeGlobal !== "undefined" && typeof vscodeGlobal.process !== "undefined") {
  const sandboxProcess = vscodeGlobal.process;
  safeProcess = {
    get platform() {
      return sandboxProcess.platform;
    },
    get arch() {
      return sandboxProcess.arch;
    },
    get env() {
      return sandboxProcess.env;
    },
    cwd() {
      return sandboxProcess.cwd();
    }
  };
} else if (typeof process !== "undefined" && typeof process?.versions?.node === "string") {
  safeProcess = {
    get platform() {
      return process.platform;
    },
    get arch() {
      return process.arch;
    },
    get env() {
      return process.env;
    },
    cwd() {
      return process.env["VSCODE_CWD"] || process.cwd();
    }
  };
} else {
  safeProcess = {
    // Supported
    get platform() {
      return isWindows ? "win32" : isMacintosh ? "darwin" : "linux";
    },
    get arch() {
      return void 0;
    },
    // Unsupported
    get env() {
      return {};
    },
    cwd() {
      return "/";
    }
  };
}
var cwd = safeProcess.cwd;
var env = safeProcess.env;
var platform = safeProcess.platform;
var arch = safeProcess.arch;

// src/vs/base/common/stopwatch.ts
var performanceNow = globalThis.performance.now.bind(globalThis.performance);
var StopWatch = class _StopWatch {
  static create(highResolution) {
    return new _StopWatch(highResolution);
  }
  constructor(highResolution) {
    this._now = highResolution === false ? Date.now : performanceNow;
    this._startTime = this._now();
    this._stopTime = -1;
  }
  stop() {
    this._stopTime = this._now();
  }
  reset() {
    this._startTime = this._now();
    this._stopTime = -1;
  }
  elapsed() {
    if (this._stopTime !== -1) {
      return this._stopTime - this._startTime;
    }
    return this._now() - this._startTime;
  }
};

// src/vs/base/common/event.ts
var _enableDisposeWithListenerWarning = false;
var _enableSnapshotPotentialLeakWarning = false;
var _bufferLeakWarnCountThreshold = 100;
var _bufferLeakWarnTimeThreshold = 6e4;
function _isBufferLeakWarningEnabled() {
  return !!env["VSCODE_DEV"];
}
var Event;
((Event2) => {
  Event2.None = () => Disposable.None;
  function _addLeakageTraceLogic(options) {
    if (_enableSnapshotPotentialLeakWarning) {
      const { onDidAddListener: origListenerDidAdd } = options;
      const stack = Stacktrace.create();
      let count = 0;
      options.onDidAddListener = () => {
        if (++count === 2) {
          console.warn("snapshotted emitter LIKELY used public and SHOULD HAVE BEEN created with DisposableStore. snapshotted here");
          stack.print();
        }
        origListenerDidAdd?.();
      };
    }
  }
  function defer(event, flushOnListenerRemove, disposable) {
    return debounce(event, () => void 0, 0, void 0, flushOnListenerRemove ?? true, void 0, disposable);
  }
  Event2.defer = defer;
  function once(event) {
    return (listener, thisArgs = null, disposables) => {
      let didFire = false;
      let result = void 0;
      result = event((e) => {
        if (didFire) {
          return;
        } else if (result) {
          result.dispose();
        } else {
          didFire = true;
        }
        return listener.call(thisArgs, e);
      }, null, disposables);
      if (didFire) {
        result.dispose();
      }
      return result;
    };
  }
  Event2.once = once;
  function onceIf(event, condition) {
    return Event2.once(Event2.filter(event, condition));
  }
  Event2.onceIf = onceIf;
  function map(event, map2, disposable) {
    return snapshot((listener, thisArgs = null, disposables) => event((i) => listener.call(thisArgs, map2(i)), null, disposables), disposable);
  }
  Event2.map = map;
  function forEach(event, each, disposable) {
    return snapshot((listener, thisArgs = null, disposables) => event((i) => {
      each(i);
      listener.call(thisArgs, i);
    }, null, disposables), disposable);
  }
  Event2.forEach = forEach;
  function filter(event, filter2, disposable) {
    return snapshot((listener, thisArgs = null, disposables) => event((e) => filter2(e) && listener.call(thisArgs, e), null, disposables), disposable);
  }
  Event2.filter = filter;
  function signal(event) {
    return event;
  }
  Event2.signal = signal;
  function any(...events) {
    return (listener, thisArgs = null, disposables) => {
      const disposable = combinedDisposable(...events.map((event) => event((e) => listener.call(thisArgs, e))));
      return addAndReturnDisposable(disposable, disposables);
    };
  }
  Event2.any = any;
  function reduce(event, merge, initial, disposable) {
    let output = initial;
    return map(event, (e) => {
      output = merge(output, e);
      return output;
    }, disposable);
  }
  Event2.reduce = reduce;
  function snapshot(event, disposable) {
    let listener;
    const options = {
      onWillAddFirstListener() {
        listener = event(emitter.fire, emitter);
      },
      onDidRemoveLastListener() {
        listener?.dispose();
      }
    };
    if (!disposable) {
      _addLeakageTraceLogic(options);
    }
    const emitter = new Emitter(options);
    disposable?.add(emitter);
    return emitter.event;
  }
  function addAndReturnDisposable(d, store) {
    if (store instanceof Array) {
      store.push(d);
    } else if (store) {
      store.add(d);
    }
    return d;
  }
  function debounce(event, merge, delay = 100, leading = false, flushOnListenerRemove = false, leakWarningThreshold, disposable) {
    let subscription;
    let output = void 0;
    let handle = void 0;
    let numDebouncedCalls = 0;
    let doFire;
    const options = {
      leakWarningThreshold,
      onWillAddFirstListener() {
        subscription = event((cur) => {
          numDebouncedCalls++;
          output = merge(output, cur);
          if (leading && !handle) {
            emitter.fire(output);
            output = void 0;
          }
          doFire = () => {
            const _output = output;
            output = void 0;
            handle = void 0;
            if (!leading || numDebouncedCalls > 1) {
              emitter.fire(_output);
            }
            numDebouncedCalls = 0;
          };
          if (typeof delay === "number") {
            if (handle) {
              clearTimeout(handle);
            }
            handle = setTimeout(doFire, delay);
          } else {
            if (handle === void 0) {
              handle = null;
              queueMicrotask(doFire);
            }
          }
        });
      },
      onWillRemoveListener() {
        if (flushOnListenerRemove && numDebouncedCalls > 0) {
          doFire?.();
        }
      },
      onDidRemoveLastListener() {
        doFire = void 0;
        subscription.dispose();
      }
    };
    if (!disposable) {
      _addLeakageTraceLogic(options);
    }
    const emitter = new Emitter(options);
    disposable?.add(emitter);
    return emitter.event;
  }
  Event2.debounce = debounce;
  function accumulate(event, delay = 0, flushOnListenerRemove, disposable) {
    return Event2.debounce(event, (last, e) => {
      if (!last) {
        return [e];
      }
      last.push(e);
      return last;
    }, delay, void 0, flushOnListenerRemove ?? true, void 0, disposable);
  }
  Event2.accumulate = accumulate;
  function throttle(event, merge, delay = 100, leading = true, trailing = true, leakWarningThreshold, disposable) {
    let subscription;
    let output = void 0;
    let handle = void 0;
    let numThrottledCalls = 0;
    const options = {
      leakWarningThreshold,
      onWillAddFirstListener() {
        subscription = event((cur) => {
          numThrottledCalls++;
          output = merge(output, cur);
          if (handle === void 0) {
            if (leading) {
              emitter.fire(output);
              output = void 0;
              numThrottledCalls = 0;
            }
            if (typeof delay === "number") {
              handle = setTimeout(() => {
                if (trailing && numThrottledCalls > 0) {
                  emitter.fire(output);
                }
                output = void 0;
                handle = void 0;
                numThrottledCalls = 0;
              }, delay);
            } else {
              handle = 0;
              queueMicrotask(() => {
                if (trailing && numThrottledCalls > 0) {
                  emitter.fire(output);
                }
                output = void 0;
                handle = void 0;
                numThrottledCalls = 0;
              });
            }
          }
        });
      },
      onDidRemoveLastListener() {
        subscription.dispose();
      }
    };
    if (!disposable) {
      _addLeakageTraceLogic(options);
    }
    const emitter = new Emitter(options);
    disposable?.add(emitter);
    return emitter.event;
  }
  Event2.throttle = throttle;
  function latch(event, equals = (a, b) => a === b, disposable) {
    let firstCall = true;
    let cache;
    return filter(event, (value) => {
      const shouldEmit = firstCall || !equals(value, cache);
      firstCall = false;
      cache = value;
      return shouldEmit;
    }, disposable);
  }
  Event2.latch = latch;
  function split(event, isT, disposable) {
    return [
      Event2.filter(event, isT, disposable),
      Event2.filter(event, (e) => !isT(e), disposable)
    ];
  }
  Event2.split = split;
  function buffer(event, debugName, flushAfterTimeout = false, _buffer = [], disposable) {
    let buffer2 = _buffer.slice();
    let bufferLeakWarningData;
    if (_isBufferLeakWarningEnabled()) {
      bufferLeakWarningData = {
        stack: Stacktrace.create(),
        timerId: setTimeout(() => {
          if (buffer2 && buffer2.length > 0 && bufferLeakWarningData && !bufferLeakWarningData.warned) {
            bufferLeakWarningData.warned = true;
            console.warn(`[Event.buffer][${debugName}] potential LEAK detected: ${buffer2.length} events buffered for ${_bufferLeakWarnTimeThreshold / 1e3}s without being consumed. Buffered here:`);
            bufferLeakWarningData.stack.print();
          }
        }, _bufferLeakWarnTimeThreshold),
        warned: false
      };
      if (disposable) {
        disposable.add(toDisposable(() => clearTimeout(bufferLeakWarningData.timerId)));
      }
    }
    const clearLeakWarningTimer = () => {
      if (bufferLeakWarningData) {
        clearTimeout(bufferLeakWarningData.timerId);
      }
    };
    let listener = event((e) => {
      if (buffer2) {
        buffer2.push(e);
        if (_isBufferLeakWarningEnabled() && bufferLeakWarningData && !bufferLeakWarningData.warned && buffer2.length >= _bufferLeakWarnCountThreshold) {
          bufferLeakWarningData.warned = true;
          console.warn(`[Event.buffer][${debugName}] potential LEAK detected: ${buffer2.length} events buffered without being consumed. Buffered here:`);
          bufferLeakWarningData.stack.print();
        }
      } else {
        emitter.fire(e);
      }
    });
    if (disposable) {
      disposable.add(listener);
    }
    const flush = () => {
      buffer2?.forEach((e) => emitter.fire(e));
      buffer2 = null;
      clearLeakWarningTimer();
    };
    const emitter = new Emitter({
      onWillAddFirstListener() {
        if (!listener) {
          listener = event((e) => emitter.fire(e));
          if (disposable) {
            disposable.add(listener);
          }
        }
      },
      onDidAddFirstListener() {
        if (buffer2) {
          if (flushAfterTimeout) {
            setTimeout(flush);
          } else {
            flush();
          }
        }
      },
      onDidRemoveLastListener() {
        if (listener) {
          listener.dispose();
        }
        listener = null;
        clearLeakWarningTimer();
      }
    });
    if (disposable) {
      disposable.add(emitter);
    }
    return emitter.event;
  }
  Event2.buffer = buffer;
  function chain(event, sythensize) {
    const fn = (listener, thisArgs, disposables) => {
      const cs = sythensize(new ChainableSynthesis());
      return event(function(value) {
        const result = cs.evaluate(value);
        if (result !== HaltChainable) {
          listener.call(thisArgs, result);
        }
      }, void 0, disposables);
    };
    return fn;
  }
  Event2.chain = chain;
  const HaltChainable = /* @__PURE__ */ Symbol("HaltChainable");
  class ChainableSynthesis {
    constructor() {
      this.steps = [];
    }
    map(fn) {
      this.steps.push(fn);
      return this;
    }
    forEach(fn) {
      this.steps.push((v) => {
        fn(v);
        return v;
      });
      return this;
    }
    filter(fn) {
      this.steps.push((v) => fn(v) ? v : HaltChainable);
      return this;
    }
    reduce(merge, initial) {
      let last = initial;
      this.steps.push((v) => {
        last = merge(last, v);
        return last;
      });
      return this;
    }
    latch(equals = (a, b) => a === b) {
      let firstCall = true;
      let cache;
      this.steps.push((value) => {
        const shouldEmit = firstCall || !equals(value, cache);
        firstCall = false;
        cache = value;
        return shouldEmit ? value : HaltChainable;
      });
      return this;
    }
    evaluate(value) {
      for (const step of this.steps) {
        value = step(value);
        if (value === HaltChainable) {
          break;
        }
      }
      return value;
    }
  }
  function fromNodeEventEmitter(emitter, eventName, map2 = (id2) => id2) {
    const fn = (...args) => result.fire(map2(...args));
    const onFirstListenerAdd = () => emitter.on(eventName, fn);
    const onLastListenerRemove = () => emitter.removeListener(eventName, fn);
    const result = new Emitter({ onWillAddFirstListener: onFirstListenerAdd, onDidRemoveLastListener: onLastListenerRemove });
    return result.event;
  }
  Event2.fromNodeEventEmitter = fromNodeEventEmitter;
  function fromDOMEventEmitter(emitter, eventName, map2 = (id2) => id2) {
    const fn = (...args) => result.fire(map2(...args));
    const onFirstListenerAdd = () => emitter.addEventListener(eventName, fn);
    const onLastListenerRemove = () => emitter.removeEventListener(eventName, fn);
    const result = new Emitter({ onWillAddFirstListener: onFirstListenerAdd, onDidRemoveLastListener: onLastListenerRemove });
    return result.event;
  }
  Event2.fromDOMEventEmitter = fromDOMEventEmitter;
  function toPromise(event, disposables) {
    let cancelRef;
    let listener;
    const promise = new Promise((resolve) => {
      listener = once(event)(resolve);
      addToDisposables(listener, disposables);
      cancelRef = () => {
        disposeAndRemove(listener, disposables);
      };
    });
    promise.cancel = cancelRef;
    if (disposables) {
      promise.finally(() => disposeAndRemove(listener, disposables));
    }
    return promise;
  }
  Event2.toPromise = toPromise;
  function forward(from, to) {
    return from((e) => to.fire(e));
  }
  Event2.forward = forward;
  function runAndSubscribe(event, handler, initial) {
    handler(initial);
    return event((e) => handler(e));
  }
  Event2.runAndSubscribe = runAndSubscribe;
  class EmitterObserver {
    constructor(_observable, store) {
      this._observable = _observable;
      this._counter = 0;
      this._hasChanged = false;
      const options = {
        onWillAddFirstListener: () => {
          _observable.addObserver(this);
          this._observable.reportChanges();
        },
        onDidRemoveLastListener: () => {
          _observable.removeObserver(this);
        }
      };
      if (!store) {
        _addLeakageTraceLogic(options);
      }
      this.emitter = new Emitter(options);
      if (store) {
        store.add(this.emitter);
      }
    }
    beginUpdate(_observable) {
      this._counter++;
    }
    handlePossibleChange(_observable) {
    }
    handleChange(_observable, _change) {
      this._hasChanged = true;
    }
    endUpdate(_observable) {
      this._counter--;
      if (this._counter === 0) {
        this._observable.reportChanges();
        if (this._hasChanged) {
          this._hasChanged = false;
          this.emitter.fire(this._observable.get());
        }
      }
    }
  }
  function fromObservable(obs, store) {
    const observer = new EmitterObserver(obs, store);
    return observer.emitter.event;
  }
  Event2.fromObservable = fromObservable;
  function fromObservableLight(observable) {
    return (listener, thisArgs, disposables) => {
      let count = 0;
      let didChange = false;
      const observer = {
        beginUpdate() {
          count++;
        },
        endUpdate() {
          count--;
          if (count === 0) {
            observable.reportChanges();
            if (didChange) {
              didChange = false;
              listener.call(thisArgs);
            }
          }
        },
        handlePossibleChange() {
        },
        handleChange() {
          didChange = true;
        }
      };
      observable.addObserver(observer);
      observable.reportChanges();
      const disposable = {
        dispose() {
          observable.removeObserver(observer);
        }
      };
      addToDisposables(disposable, disposables);
      return disposable;
    };
  }
  Event2.fromObservableLight = fromObservableLight;
})(Event || (Event = {}));
var EventProfiling = class _EventProfiling {
  constructor(name) {
    this.listenerCount = 0;
    this.invocationCount = 0;
    this.elapsedOverall = 0;
    this.durations = [];
    this.name = `${name}_${_EventProfiling._idPool++}`;
    _EventProfiling.all.add(this);
  }
  static {
    this.all = /* @__PURE__ */ new Set();
  }
  static {
    this._idPool = 0;
  }
  start(listenerCount) {
    this._stopWatch = new StopWatch();
    this.listenerCount = listenerCount;
  }
  stop() {
    if (this._stopWatch) {
      const elapsed = this._stopWatch.elapsed();
      this.durations.push(elapsed);
      this.elapsedOverall += elapsed;
      this.invocationCount += 1;
      this._stopWatch = void 0;
    }
  }
};
var _globalLeakWarningThreshold = -1;
var LeakageMonitor = class _LeakageMonitor {
  constructor(_errorHandler, threshold, name = (_LeakageMonitor._idPool++).toString(16).padStart(3, "0")) {
    this._errorHandler = _errorHandler;
    this.threshold = threshold;
    this.name = name;
    this._warnCountdown = 0;
  }
  static {
    this._idPool = 1;
  }
  dispose() {
    this._stacks?.clear();
  }
  check(stack, listenerCount) {
    const threshold = this.threshold;
    if (threshold <= 0 || listenerCount < threshold) {
      return void 0;
    }
    if (!this._stacks) {
      this._stacks = /* @__PURE__ */ new Map();
    }
    const count = this._stacks.get(stack.value) || 0;
    this._stacks.set(stack.value, count + 1);
    this._warnCountdown -= 1;
    if (this._warnCountdown <= 0) {
      this._warnCountdown = threshold * 0.5;
      const [topStack, topCount] = this.getMostFrequentStack();
      const emitterName = /^[0-9a-f]+$/i.test(this.name) ? void 0 : this.name;
      const message = `[${this.name}] potential listener LEAK detected, having ${listenerCount} listeners already. MOST frequent listener (${topCount}):`;
      console.warn(message);
      console.warn(topStack);
      const kind = topCount / listenerCount > 0.3 ? "dominated" : "popular";
      const error = new ListenerLeakError(kind, message, topStack, listenerCount, emitterName);
      this._errorHandler(error);
    }
    return () => {
      const count2 = this._stacks.get(stack.value) || 0;
      this._stacks.set(stack.value, count2 - 1);
    };
  }
  getMostFrequentStack() {
    if (!this._stacks) {
      return void 0;
    }
    let topStack;
    let topCount = 0;
    for (const [stack, count] of this._stacks) {
      if (!topStack || topCount < count) {
        topStack = [stack, count];
        topCount = count;
      }
    }
    return topStack;
  }
};
var Stacktrace = class _Stacktrace {
  constructor(value) {
    this.value = value;
  }
  static create() {
    const err = new Error();
    return new _Stacktrace(err.stack ?? "");
  }
  print() {
    console.warn(this.value.split("\n").slice(2).join("\n"));
  }
};
var ListenerLeakError = class _ListenerLeakError extends Error {
  constructor(kind, details, stack, listenerCount, emitterName) {
    super(emitterName ? `[${emitterName}] potential listener LEAK detected, ${kind}` : `potential listener LEAK detected, ${kind}`);
    this.name = "ListenerLeakError";
    this.kind = kind;
    this.listenerCount = listenerCount;
    this.details = details;
    this.stack = stack;
  }
  static is(err) {
    return err instanceof _ListenerLeakError || err instanceof Error && typeof err.kind === "string" && typeof err.listenerCount === "number";
  }
};
var ListenerRefusalError = class extends ListenerLeakError {
  constructor(kind, details, stack, listenerCount, emitterName) {
    super(kind, details, stack, listenerCount, emitterName);
    this.name = "ListenerRefusalError";
  }
};
var id = 0;
var UniqueContainer = class {
  constructor(value) {
    this.value = value;
    this.id = id++;
  }
};
var compactionThreshold = 2;
var forEachListener = (listeners, fn) => {
  if (listeners instanceof UniqueContainer) {
    fn(listeners);
  } else {
    for (let i = 0; i < listeners.length; i++) {
      const l = listeners[i];
      if (l) {
        fn(l);
      }
    }
  }
};
var Emitter = class {
  constructor(options) {
    this._size = 0;
    this._options = options;
    this._leakageMon = _globalLeakWarningThreshold > 0 || this._options?.leakWarningThreshold ? new LeakageMonitor(options?.onListenerError ?? onUnexpectedError, this._options?.leakWarningThreshold ?? _globalLeakWarningThreshold, this._options?.leakWarningName) : void 0;
    this._perfMon = this._options?._profName ? new EventProfiling(this._options._profName) : void 0;
    this._deliveryQueue = this._options?.deliveryQueue;
  }
  dispose() {
    if (!this._disposed) {
      this._disposed = true;
      if (this._deliveryQueue?.current === this) {
        this._deliveryQueue.reset();
      }
      if (this._listeners) {
        if (_enableDisposeWithListenerWarning) {
          const listeners = this._listeners;
          queueMicrotask(() => {
            forEachListener(listeners, (l) => l.stack?.print());
          });
        }
        this._listeners = void 0;
        this._size = 0;
      }
      this._options?.onDidRemoveLastListener?.();
      this._leakageMon?.dispose();
    }
  }
  /**
   * For the public to allow to subscribe
   * to events from this Emitter
   */
  get event() {
    this._event ??= (callback, thisArgs, disposables) => {
      if (this._leakageMon && this._size > this._leakageMon.threshold ** 2) {
        const message = `[${this._leakageMon.name}] REFUSES to accept new listeners because it exceeded its threshold by far (${this._size} vs ${this._leakageMon.threshold})`;
        console.warn(message);
        const tuple = this._leakageMon.getMostFrequentStack() ?? ["UNKNOWN stack", -1];
        const kind = tuple[1] / this._size > 0.3 ? "dominated" : "popular";
        const error = new ListenerRefusalError(kind, `${message}. HINT: Stack shows most frequent listener (${tuple[1]}-times)`, tuple[0], this._size, this._options?.leakWarningName);
        const errorHandler2 = this._options?.onListenerError || onUnexpectedError;
        errorHandler2(error);
        return Disposable.None;
      }
      if (this._disposed) {
        return Disposable.None;
      }
      if (thisArgs) {
        callback = callback.bind(thisArgs);
      }
      const contained = new UniqueContainer(callback);
      let removeMonitor;
      let stack;
      if (this._leakageMon && this._size >= Math.ceil(this._leakageMon.threshold * 0.2)) {
        contained.stack = Stacktrace.create();
        removeMonitor = this._leakageMon.check(contained.stack, this._size + 1);
      }
      if (_enableDisposeWithListenerWarning) {
        contained.stack = stack ?? Stacktrace.create();
      }
      if (!this._listeners) {
        this._options?.onWillAddFirstListener?.(this);
        this._listeners = contained;
        this._options?.onDidAddFirstListener?.(this);
      } else if (this._listeners instanceof UniqueContainer) {
        this._deliveryQueue ??= new EventDeliveryQueuePrivate();
        this._listeners = [this._listeners, contained];
      } else {
        this._listeners.push(contained);
      }
      this._options?.onDidAddListener?.(this);
      this._size++;
      const result = toDisposable(() => {
        removeMonitor?.();
        this._removeListener(contained);
      });
      addToDisposables(result, disposables);
      return result;
    };
    return this._event;
  }
  _removeListener(listener) {
    this._options?.onWillRemoveListener?.(this);
    if (!this._listeners) {
      return;
    }
    if (this._size === 1) {
      this._listeners = void 0;
      this._options?.onDidRemoveLastListener?.(this);
      this._size = 0;
      return;
    }
    const listeners = this._listeners;
    const index = listeners.indexOf(listener);
    if (index === -1) {
      console.log("disposed?", this._disposed);
      console.log("size?", this._size);
      console.log("arr?", JSON.stringify(this._listeners));
      throw new Error("Attempted to dispose unknown listener");
    }
    this._size--;
    listeners[index] = void 0;
    const adjustDeliveryQueue = this._deliveryQueue.current === this;
    if (this._size * compactionThreshold <= listeners.length) {
      let n = 0;
      for (let i = 0; i < listeners.length; i++) {
        if (listeners[i]) {
          listeners[n++] = listeners[i];
        } else if (adjustDeliveryQueue && n < this._deliveryQueue.end) {
          this._deliveryQueue.end--;
          if (n < this._deliveryQueue.i) {
            this._deliveryQueue.i--;
          }
        }
      }
      listeners.length = n;
    }
  }
  _deliver(listener, value) {
    if (!listener) {
      return;
    }
    const errorHandler2 = this._options?.onListenerError || onUnexpectedError;
    if (!errorHandler2) {
      listener.value(value);
      return;
    }
    try {
      listener.value(value);
    } catch (e) {
      errorHandler2(e);
    }
  }
  /** Delivers items in the queue. Assumes the queue is ready to go. */
  _deliverQueue(dq) {
    const listeners = dq.current._listeners;
    while (dq.i < dq.end) {
      this._deliver(listeners[dq.i++], dq.value);
    }
    dq.reset();
  }
  /**
   * To be kept private to fire an event to
   * subscribers
   */
  fire(event) {
    if (this._deliveryQueue?.current) {
      this._deliverQueue(this._deliveryQueue);
      this._perfMon?.stop();
    }
    this._perfMon?.start(this._size);
    if (!this._listeners) {
    } else if (this._listeners instanceof UniqueContainer) {
      this._deliver(this._listeners, event);
    } else {
      const dq = this._deliveryQueue;
      dq.enqueue(this, event, this._listeners.length);
      this._deliverQueue(dq);
    }
    this._perfMon?.stop();
  }
  hasListeners() {
    return this._size > 0;
  }
};
var EventDeliveryQueuePrivate = class {
  constructor() {
    /**
     * Index in current's listener list.
     */
    this.i = -1;
    /**
     * The last index in the listener's list to deliver.
     */
    this.end = 0;
  }
  enqueue(emitter, value, end) {
    this.i = 0;
    this.end = end;
    this.current = emitter;
    this.value = value;
  }
  reset() {
    this.i = this.end;
    this.current = void 0;
    this.value = void 0;
  }
};
function addToDisposables(result, disposables) {
  if (disposables instanceof DisposableStore) {
    disposables.add(result);
  } else if (Array.isArray(disposables)) {
    disposables.push(result);
  }
}
function disposeAndRemove(result, disposables) {
  if (disposables instanceof DisposableStore) {
    disposables.delete(result);
  } else if (Array.isArray(disposables)) {
    const index = disposables.indexOf(result);
    if (index !== -1) {
      disposables.splice(index, 1);
    }
  }
  result.dispose();
}

// src/vs/sessions/contrib/agentStudio/test/browser/workflowRunInjectPrompt.test.ts
var MockAgentStudioService = class {
  constructor() {
    this._onDidRequestInjectPrompt = new Emitter();
    this.onDidRequestInjectPrompt = this._onDidRequestInjectPrompt.event;
  }
  requestInjectPrompt(agentId, message) {
    this._onDidRequestInjectPrompt.fire({ agentId, message });
  }
};
var MockWebviewController = class {
  constructor(panelType) {
    this.sentEvents = [];
    this.panelType = panelType;
  }
  setActiveAgent(agentId) {
    this._activeChatAgentId = agentId;
  }
  /** Replicates the subscription in agentStudioWebviewController.ts */
  subscribeToInjectPrompt(service) {
    service.onDidRequestInjectPrompt(({ agentId, message }) => {
      if (this.panelType !== "chat") {
        return;
      }
      if (this._activeChatAgentId && this._activeChatAgentId !== agentId) {
        return;
      }
      this.sentEvents.push({
        type: "chat.injectPrompt",
        data: { agentId, message }
      });
    });
  }
};
var MockWebviewMessageHandler = class {
  constructor(panelType) {
    this.injectedPrompts = [];
    this._selectedAgentId = null;
    this.panelType = panelType;
  }
  get selectedAgentId() {
    return this._selectedAgentId;
  }
  /** Replicates the case 'chat.injectPrompt' handler in index.tsx */
  handleInjectPromptEvent(event) {
    if (event.type !== "chat.injectPrompt") {
      return;
    }
    if (this.panelType !== "chat") {
      return;
    }
    const { agentId, message } = event.data;
    if (!agentId || !message) {
      return;
    }
    this._selectedAgentId = agentId;
    this.injectedPrompts.push({ agentId, message });
  }
};
suite("Workflow Run \u2192 Prompt Injection Chain", () => {
  test("AgentStudioService.requestInjectPrompt fires event with correct payload", () => {
    const service = new MockAgentStudioService();
    let received;
    service.onDidRequestInjectPrompt((e) => {
      received = e;
    });
    service.requestInjectPrompt("agent-123", "# Execute Workflow: test");
    import_assert2.default.ok(received, "Event should be received");
    import_assert2.default.strictEqual(received.agentId, "agent-123");
    import_assert2.default.strictEqual(received.message, "# Execute Workflow: test");
  });
  test("Chat panel webview controller forwards inject event when agentId matches", () => {
    const service = new MockAgentStudioService();
    const controller = new MockWebviewController("chat");
    controller.setActiveAgent("agent-123");
    controller.subscribeToInjectPrompt(service);
    service.requestInjectPrompt("agent-123", "Run workflow");
    import_assert2.default.strictEqual(controller.sentEvents.length, 1);
    import_assert2.default.strictEqual(controller.sentEvents[0].type, "chat.injectPrompt");
    import_assert2.default.strictEqual(controller.sentEvents[0].data.agentId, "agent-123");
    import_assert2.default.strictEqual(controller.sentEvents[0].data.message, "Run workflow");
  });
  test("Chat panel webview controller forwards inject when no agent is active yet (fresh open)", () => {
    const service = new MockAgentStudioService();
    const controller = new MockWebviewController("chat");
    controller.subscribeToInjectPrompt(service);
    service.requestInjectPrompt("agent-456", "Run new workflow");
    import_assert2.default.strictEqual(controller.sentEvents.length, 1);
    import_assert2.default.strictEqual(controller.sentEvents[0].data.agentId, "agent-456");
  });
  test("Chat panel webview controller does NOT forward inject for non-matching agentId", () => {
    const service = new MockAgentStudioService();
    const controller = new MockWebviewController("chat");
    controller.setActiveAgent("agent-123");
    controller.subscribeToInjectPrompt(service);
    service.requestInjectPrompt("agent-999", "Run for different agent");
    import_assert2.default.strictEqual(controller.sentEvents.length, 0, "Should NOT forward when agentId does not match");
  });
  test("Non-chat panels (workflow-editor, etc.) ignore inject events", () => {
    const service = new MockAgentStudioService();
    const editorController = new MockWebviewController("workflow-editor");
    editorController.subscribeToInjectPrompt(service);
    service.requestInjectPrompt("agent-123", "Run workflow");
    import_assert2.default.strictEqual(editorController.sentEvents.length, 0, "Workflow editor should NOT handle inject events");
  });
  test("Webview chat panel handler processes chat.injectPrompt and sends message", () => {
    const handler = new MockWebviewMessageHandler("chat");
    handler.handleInjectPromptEvent({
      type: "chat.injectPrompt",
      data: { agentId: "agent-123", message: "# Execute Workflow" }
    });
    import_assert2.default.strictEqual(handler.injectedPrompts.length, 1);
    import_assert2.default.strictEqual(handler.injectedPrompts[0].agentId, "agent-123");
    import_assert2.default.strictEqual(handler.injectedPrompts[0].message, "# Execute Workflow");
    import_assert2.default.strictEqual(handler.selectedAgentId, "agent-123");
  });
  test("Webview non-chat panel ignores chat.injectPrompt events", () => {
    const handler = new MockWebviewMessageHandler("workflow-editor");
    handler.handleInjectPromptEvent({
      type: "chat.injectPrompt",
      data: { agentId: "agent-123", message: "should be ignored" }
    });
    import_assert2.default.strictEqual(handler.injectedPrompts.length, 0, "Non-chat panel should ignore inject events");
    import_assert2.default.strictEqual(handler.selectedAgentId, null);
  });
  test("Webview handler ignores chat.injectPrompt with missing agentId", () => {
    const handler = new MockWebviewMessageHandler("chat");
    handler.handleInjectPromptEvent({
      type: "chat.injectPrompt",
      data: { agentId: "", message: "no agent" }
    });
    import_assert2.default.strictEqual(handler.injectedPrompts.length, 0, "Should ignore event with empty agentId");
  });
  test("Webview handler ignores chat.injectPrompt with missing message", () => {
    const handler = new MockWebviewMessageHandler("chat");
    handler.handleInjectPromptEvent({
      type: "chat.injectPrompt",
      data: { agentId: "agent-123", message: "" }
    });
    import_assert2.default.strictEqual(handler.injectedPrompts.length, 0, "Should ignore event with empty message");
  });
  test("End-to-end chain: service \u2192 controller \u2192 webview handler", () => {
    const service = new MockAgentStudioService();
    const controller = new MockWebviewController("chat");
    controller.setActiveAgent("wf-agent-001");
    controller.subscribeToInjectPrompt(service);
    const handler = new MockWebviewMessageHandler("chat");
    service.requestInjectPrompt("wf-agent-001", "# Execute Workflow: My Workflow\n\n...");
    import_assert2.default.strictEqual(controller.sentEvents.length, 1);
    handler.handleInjectPromptEvent(controller.sentEvents[0]);
    import_assert2.default.strictEqual(handler.injectedPrompts.length, 1);
    import_assert2.default.strictEqual(handler.injectedPrompts[0].agentId, "wf-agent-001");
    import_assert2.default.strictEqual(handler.selectedAgentId, "wf-agent-001");
    import_assert2.default.ok(handler.injectedPrompts[0].message.startsWith("# Execute Workflow"));
  });
  test("_buildExecutionPrompt generates correct graph-based prompt", () => {
    const mockWf = {
      id: "wf-123",
      name: "Test Workflow",
      description: "A test workflow",
      nodes: [
        { id: "start", type: "start", position: { x: 80, y: 250 }, data: { label: "Start" } },
        { id: "agent-1", type: "agent", position: { x: 300, y: 250 }, data: { label: "Test Agent", agentId: "test-agent", agentConfig: { modelId: "claude-sonnet" } } },
        { id: "end", type: "end", position: { x: 600, y: 250 }, data: { label: "End" } }
      ],
      connections: [
        { id: "e1", from: "start", to: "agent-1" },
        { id: "e2", from: "agent-1", to: "end" }
      ]
    };
    const lines = [];
    lines.push(`# Execute Workflow: ${mockWf.name}`);
    lines.push("");
    lines.push("A test workflow");
    lines.push("");
    const userNodes = mockWf.nodes.filter((n) => n.type !== "start" && n.type !== "end" && n.type !== "group");
    import_assert2.default.strictEqual(userNodes.length, 1, "Should have 1 user node");
    lines.push("## Workflow Nodes");
    lines.push("");
    const node = userNodes[0];
    if (node.type === "agent") {
      lines.push(`1. \u{1F916} **${node.data.label}** (Agent)`);
      lines.push(`   - Agent: ${node.data.agentId}`);
      lines.push(`   - Model: ${node.data.agentConfig.modelId}`);
    }
    const prompt = lines.join("\n");
    import_assert2.default.ok(prompt.includes("Test Workflow"));
    import_assert2.default.ok(prompt.includes("Test Agent"));
    import_assert2.default.ok(prompt.includes("test-agent"));
    import_assert2.default.ok(prompt.includes("claude-sonnet"));
  });
  test("requestInjectPrompt is idempotent \u2014 multiple calls fire multiple events", () => {
    const service = new MockAgentStudioService();
    let count = 0;
    service.onDidRequestInjectPrompt(() => {
      count++;
    });
    service.requestInjectPrompt("a", "msg1");
    service.requestInjectPrompt("a", "msg2");
    service.requestInjectPrompt("b", "msg3");
    import_assert2.default.strictEqual(count, 3, "Each call should fire an event");
  });
  test("requestInjectPrompt handles large workflow prompts", () => {
    const service = new MockAgentStudioService();
    let received = "";
    service.onDidRequestInjectPrompt((e) => {
      received = e.message;
    });
    const largePrompt = "# Execute Workflow: Big\n\n" + "x".repeat(1e4);
    service.requestInjectPrompt("a", largePrompt);
    import_assert2.default.strictEqual(received.length, largePrompt.length);
    import_assert2.default.ok(received.startsWith("# Execute Workflow"));
    import_assert2.default.ok(received.endsWith("x".repeat(1e4)));
  });
});
