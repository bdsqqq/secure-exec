'use strict';

module.exports = class Countdown {
  constructor(limit, callback) {
    this.remaining = limit;
    this.callback = callback;
  }

  dec() {
    if (this.remaining <= 0) {
      return 0;
    }
    this.remaining -= 1;
    if (this.remaining === 0 && typeof this.callback === 'function') {
      this.callback();
    }
    return this.remaining;
  }
};
