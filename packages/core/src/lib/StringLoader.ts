/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @lightSyntaxTransform
 * @oncall web_perf_infra
 */

'use strict';

import info from './Console';
import fs from 'fs';

const nums = Object.create(null);
for (let i = 0; i < 10; i++) {
  nums[`${i}`] = i;
}

type ReadFileOptions = {
  startSignature?: string;
  endSignature?: string;
  inclusive?: boolean;
};

type NodeFSError = NodeJS.ErrnoException | null;

const EMPTY_UINT32_ARRAY = new Uint32Array(0);

class StringLoader {
  processErrorIfNotNull(err: NodeFSError): void {
    if (!err) {
      return;
    }
    info.error(err.message);
    throw err;
  }

  // This API reads specified file one chunk at a time,
  // identifies and returns the content that:
  // 1) starts with options.startSignature
  // 2) ends with options.endSignature
  readFile(file: string, options: ReadFileOptions = {}): Promise<string> {
    const _buffer = Buffer.alloc(1024 * 1024); // 1MB
    const _fd = fs.openSync(file, 'r');

    const _startSig = options.startSignature;
    const _endSig = options.endSignature;
    const _errHandler = this.processErrorIfNotNull;
    const inclusive = !!options.inclusive;

    let _resolve: (result: string) => void;
    let _result = '';
    let _begin = false;
    let _end = false;
    let _pos = 0;

    const readCallback = function (err: NodeFSError, bytes: number) {
      _errHandler(err);

      const str = _buffer.slice(0, bytes).toString('UTF-8');

      if (!_begin && !_startSig) {
        // start reserving content if no start signature is specified
        _begin = true;
      }

      _result += str;

      // look for start signature
      if (!_begin && _startSig != null) {
        const idx = _result.indexOf(_startSig);
        if (idx >= 0) {
          _begin = true;
          _result = _result.substring(idx + _startSig.length);
        } else if (_result.length > _startSig.length) {
          _result = _result.substring(_result.length - _startSig.length);
        }
      }

      // look for end signature
      if (_begin && _endSig) {
        let searchIdx = Math.max(
          0,
          _result.length - str.length - _endSig.length,
        );
        if (_startSig && searchIdx < _startSig.length) {
          searchIdx = _startSig.length;
        }
        const idx = _result.indexOf(_endSig, searchIdx);
        if (idx >= 0) {
          _result = _result.substring(0, idx);
          _end = true;
        }
      }

      if (_end || bytes < _buffer.length) {
        if (!_begin) {
          _result = '';
        }
        if (inclusive && _startSig) {
          _result = _startSig + _result;
        }
        if (inclusive && _endSig && _end) {
          _result += _endSig;
        }
        _resolve(_result);
        fs.close(_fd, _errHandler);
      } else {
        _pos += bytes;
        fs.read(_fd, _buffer, 0, _buffer.length, _pos, readCallback);
      }
    };

    fs.read(_fd, _buffer, 0, _buffer.length, _pos, readCallback);

    return new Promise(r => {
      _resolve = r;
    });
  }

  // This API reads the file one chunk at a time,
  // excludes a JSON field that looks like "${fieldsToIgnore}: []"
  // and returns the rest of the file content.
  readFileAndExcludeTypedArray(
    file: string,
    fieldsToIgnore: string[],
  ): Promise<string> {
    const _buffer = Buffer.alloc(1024 * 4 * 1024); // 4MB
    const _fd = fs.openSync(file, 'r');
    const _errHandler = this.processErrorIfNotNull;

    fieldsToIgnore = fieldsToIgnore.map(field => `"${field}":`);
    const _fieldToIgnoreMaxLength = fieldsToIgnore.reduce(
      (max, field) => (max < field.length ? field.length : max),
      Infinity,
    );

    let _resolve: (result: string) => void;
    let _result = '';
    let _curFieldToIgnore: string | null = null;
    let _pos = 0;

    const readCallback = function (err: NodeFSError, bytes: number) {
      _errHandler(err);

      let str = _buffer.slice(0, bytes).toString('UTF-8');

      // look for end of field
      if (_curFieldToIgnore) {
        const endIdx = str.indexOf(']');
        if (endIdx >= 0) {
          str = str.substring(endIdx - 1);
          _curFieldToIgnore = null;
        } else {
          str = '';
        }
      }

      _result += str;

      let searchIdx = -1;
      // look for start of ignored fields
      while (!_curFieldToIgnore && fieldsToIgnore.length > 0) {
        if (searchIdx < 0) {
          searchIdx = _result.length - str.length - _fieldToIgnoreMaxLength;
          searchIdx = Math.max(0, searchIdx);
        }

        const idxs = fieldsToIgnore.map(field =>
          _result.indexOf(field, searchIdx),
        );
        let curMinIndex = Infinity;
        for (let i = 0; i < idxs.length; ++i) {
          if (idxs[i] >= 0 && curMinIndex > idxs[i]) {
            curMinIndex = idxs[i];
            _curFieldToIgnore = fieldsToIgnore[i];
          }
        }

        // if no ignore fields found
        if (!_curFieldToIgnore) {
          break;
        }

        // search for end of the field
        const endIdx = _result.indexOf(']', curMinIndex);
        if (endIdx >= 0) {
          const endOfPrefix = curMinIndex + _curFieldToIgnore.length;
          const prefix = _result.substring(0, endOfPrefix);
          const suffix = _result.substring(endIdx);
          _result = prefix + '[' + suffix;
          searchIdx = endOfPrefix + 2;
          _curFieldToIgnore = null;
        } else {
          _result =
            _result.substring(0, curMinIndex + _curFieldToIgnore.length) + '[';
          break;
        }
      }

      if (bytes < _buffer.length) {
        _resolve(_result);
        fs.close(_fd, _errHandler);
      } else {
        _pos += bytes;
        fs.read(_fd, _buffer, 0, _buffer.length, _pos, readCallback);
      }
    };

    // continue reading the next chunk of data
    fs.read(_fd, _buffer, 0, _buffer.length, _pos, readCallback);

    return new Promise(r => {
      _resolve = r;
    });
  }

  // This API reads the file one chunk at a time,
  // only extracts a JSON field that looks like ${fieldsToIgnore}: [],
  // converts/returns that field into a typed array.
  readFileAndExtractTypedArray(
    file: string,
    field: string,
  ): Promise<Uint32Array> {
    const _buffer = Buffer.alloc(16 * 1024 * 1024); // 16MB
    const _fd = fs.openSync(file, 'r');
    const _errHandler = this.processErrorIfNotNull;
    const _startSig = `"${field}":`;
    const _resultBufSize = 32 * 1024 * 1024;
    const _resultBufs = [new Uint32Array(_resultBufSize)];
    let _i = 0;
    let _j = 0;

    const addToBuffer = (num: number) => {
      if (_j >= _resultBufs[_i].length) {
        _resultBufs.push(new Uint32Array(_resultBufSize));
        ++_i;
        _j = 0;
      }
      _resultBufs[_i][_j++] = num;
    };

    const consolicateBuffer = () => {
      let n = 0;
      for (let i = 0; i <= _i; ++i) {
        n += i < _i ? _resultBufs[i].length : _j;
      }
      const ret = new Uint32Array(n);
      let k = 0;
      for (let i = 0; i <= _i; ++i) {
        const buf = _resultBufs[i];
        const l = i < _i ? buf.length : _j;
        for (let j = 0; j < l; ++j) {
          ret[k++] = buf[j];
        }
        _resultBufs[i] = EMPTY_UINT32_ARRAY;
      }
      return ret;
    };

    let _strBuf = '';
    let _pos = 0;
    let _begin = false;
    let _end = false;
    let _resolve: (result: Uint32Array) => void;

    const readCallback = function (err: NodeFSError, bytes: number): void {
      _errHandler(err);

      const buf =
        bytes === _buffer.byteLength ? _buffer : _buffer.slice(0, bytes);
      const str = buf.toString('UTF-8');

      _strBuf += str;

      // look for start signature
      if (!_begin) {
        const idx = _strBuf.indexOf(_startSig);
        if (idx >= 0) {
          _begin = true;
          _strBuf = _strBuf.substring(idx + _startSig.length);
        } else if (_strBuf.length > _startSig.length) {
          _strBuf = _strBuf.substring(_strBuf.length - _startSig.length);
        }
      }

      // start converting to typed array and look for end of field
      if (_begin) {
        let idx = -1;
        let num = 0;
        let beginParseNum = false;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (++idx >= _strBuf.length) {
            // rollback the parsing of the last number
            _strBuf = _strBuf.substring(_strBuf.lastIndexOf(',') + 1);
            break;
          }
          const char = _strBuf[idx];
          if (char === '[' || char === ' ' || char === '\n') {
            continue;
          }
          if (char === ']') {
            if (beginParseNum) {
              addToBuffer(num);
            }
            _end = true;
            break;
          } else if (char === ',') {
            if (beginParseNum) {
              addToBuffer(num);
            }
            beginParseNum = false;
            num = 0;
          } else if ('0' <= char && char <= '9') {
            beginParseNum = true;
            num = 10 * num + nums[char];
          }
        }
      }

      if (_end || bytes < _buffer.length) {
        // consolicate the buffers
        _resolve(consolicateBuffer());
        fs.close(_fd, _errHandler);
      } else {
        _pos += bytes;
        fs.read(_fd, _buffer, 0, _buffer.length, _pos, readCallback);
      }
    };

    // continue reading the next chunk of data
    fs.read(_fd, _buffer, 0, _buffer.length, _pos, readCallback);

    return new Promise(r => {
      _resolve = r;
    });
  }
}

export default new StringLoader();
