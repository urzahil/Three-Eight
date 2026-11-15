// Globals the browser modules use that Node 18 lacks (CustomEvent became a global in Node 19).
// Import this before the module under test.
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.detail = init.detail ?? null;
    }
  };
}
