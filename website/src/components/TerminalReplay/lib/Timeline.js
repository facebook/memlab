/**
 * Copyright (c) 2011-2012 Caleb Troughton
 * Licensed under the MIT license.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/* @nolint */

const __bind = function (fn, me) {
  return function () {
    return fn.apply(me, arguments);
  };
};
const __slice = Array.prototype.slice;

const every = function (ms, callback) {
  return setInterval(callback, ms);
};

const Timeline = (function () {
  Timeline.defaults = {
    frequency: 100,
    length: 0,
  };

  Timeline.prototype._lastPosition = 0;

  Timeline.prototype._position = 0;

  Timeline.prototype._timer = -1;

  Timeline.prototype._previousTick = 0;

  Timeline.prototype._createTick = function () {
    clearInterval(this._timer);
    return (this._timer = every(this._options.frequency, this._onTick));
  };

  Timeline.prototype._onTick = function () {
    let now;
    now = new Date().getTime();
    this._updatePositions(now);
    this._triggerMarkers();
    this._previousTick = now;
    this.trigger('tick');
    return this._checkForEnd();
  };

  Timeline.prototype._updatePositions = function (now) {
    this._lastPosition = this._position;
    this._position += now - this._previousTick;
    if (this._position > this._options.length) {
      return (this._position = this._options.length);
    }
  };

  Timeline.prototype._triggerMarkers = function () {
    let marker, _i, _len, _ref, _ref2, _ref3, _results;
    _ref = this.markers;
    _results = [];
    for (_i = 0, _len = _ref.length; _i < _len; _i++) {
      marker = _ref[_i];
      if (
        this._lastPosition > (_ref2 = marker.time) &&
        _ref2 >= this._position
      ) {
        marker.backward();
      }
      if (
        this._lastPosition <= (_ref3 = marker.time) &&
        _ref3 < this._position
      ) {
        _results.push(marker.forward());
      } else {
        _results.push(void 0);
      }
    }
    return _results;
  };

  // Added function to iterate backwards
  Timeline.prototype._triggerMarkersRollback = function () {
    let marker, _i, _len, _ref, _ref2, _ref3, _results;
    _ref = this.markers;
    _results = [];
    for (_i = _ref.length - 1, _len = 0; _i > _len; _i--) {
      marker = _ref[_i];
      // On move backward
      if (
        this._lastPosition > (_ref2 = marker.time) &&
        _ref2 >= this._position
      ) {
        marker.backward();
      }
      // On move forward the time line, this will never execute
      if (
        this._lastPosition <= (_ref3 = marker.time) &&
        _ref3 < this._position
      ) {
        _results.push(marker.forward());
      } else {
        _results.push(void 0);
      }
    }
    return _results;
  };

  Timeline.prototype._checkForEnd = function () {
    if (this._position >= this._options.length) {
      this._position = this._options.length;
      this.pause();
      return this.trigger('end');
    }
  };

  Timeline.prototype.playing = false;

  Timeline.prototype.markers = [];

  function Timeline(options) {
    this._onTick = __bind(this._onTick, this);
    let key, val, _ref;
    this._options = {};
    _ref = Timeline.defaults;
    for (key in _ref) {
      val = _ref[key];
      this._options[key] = val;
    }
    for (key in options) {
      val = options[key];
      this._options[key] = val;
    }
    this._events = {};
  }

  Timeline.prototype.length = function (ms) {
    if (ms != null) {
      this._options.length = ms;
      return this;
    } else {
      return this._options.length;
    }
  };

  Timeline.prototype.frequency = function (ms) {
    if (ms != null) {
      this._options.frequency = ms;
      return this;
    } else {
      return this._options.frequency;
    }
  };

  Timeline.prototype.position = function (ms) {
    if (ms != null) {
      if (ms > this._options.length) ms = this._options.length;
      if (ms < 0) ms = 0;
      this._lastPosition = this._position;
      this._position = ms;
      if (this._position < this._lastPosition) {
        //
        this._triggerMarkersRollback();
      } else {
        this._triggerMarkers();
      }
      this.trigger('tick');
      this._checkForEnd();
      return this;
    } else {
      return this._position;
    }
  };

  Timeline.prototype.play = function () {
    if (!this.playing) {
      this.playing = true;
      this._previousTick = new Date().getTime();
      this._createTick();
      this.trigger('play');
    }
    return this;
  };

  Timeline.prototype.pause = function () {
    if (this.playing) {
      this.playing = false;
      clearInterval(this._timer);
      this.trigger('pause');
    }
    return this;
  };

  Timeline.prototype.on = function (event, callback) {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(callback);
    return this;
  };

  Timeline.prototype.off = function (event, callback) {
    let cb;
    if (this._events[event] != null && callback != null) {
      this._events[event] = function () {
        let _i, _len, _ref, _results;
        _ref = this._events[event];
        _results = [];
        for (_i = 0, _len = _ref.length; _i < _len; _i++) {
          cb = _ref[_i];
          if (cb !== callback) _results.push(cb);
        }
        return _results;
      }.call(this);
    } else {
      this._events[event] = [];
    }
    return this;
  };

  Timeline.prototype.trigger = function () {
    let args, callback, event, _i, _len, _ref;
    (event = arguments[0]),
      (args = 2 <= arguments.length ? __slice.call(arguments, 1) : []);
    if (this._events[event] != null) {
      _ref = this._events[event];
      for (_i = 0, _len = _ref.length; _i < _len; _i++) {
        callback = _ref[_i];
        callback.apply(this, args);
      }
    }
    return this;
  };

  return Timeline;
})();

export default Timeline;
