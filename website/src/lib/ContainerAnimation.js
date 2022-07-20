//
// Copyright (C) 2013 Matthew Wagerfield
//
// Twitter: https://twitter.com/mwagerfield
//
// Permission is hereby granted, free of charge, to any
// person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the
// Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do
// so, subject to the following conditions:
//
// The above copyright notice and this permission notice
// shall be included in all copies or substantial portions
// of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY
// OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
// FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
// EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
// FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
// AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
// OR OTHER DEALINGS IN THE SOFTWARE.
//
//============================================================

/* @nolint */

/**
 * Defines the Flat Surface Shader namespace for all the awesomeness to exist upon.
 * @author Matthew Wagerfield
 */
const FSS = {
  FRONT: 0,
  BACK: 1,
  DOUBLE: 2,
  SVGNS: 'http://www.w3.org/2000/svg',
};

/**
 * @class Array
 * @author Matthew Wagerfield
 */
FSS.Array = typeof Float32Array === 'function' ? Float32Array : Array;

/**
 * @class Utils
 * @author Matthew Wagerfield
 */
FSS.Utils = {
  isNumber(value) {
    return !isNaN(parseFloat(value)) && isFinite(value);
  },
};

export default function startAnimation(containerID) {
  let canvas = null;
  /**
   * Request Animation Frame Polyfill.
   * @author Paul Irish
   * @see https://gist.github.com/paulirish/1579671
   */
  (function () {
    let lastTime = 0;
    const vendors = ['ms', 'moz', 'webkit', 'o'];

    for (let x = 0; x < vendors.length && !window.requestAnimationFrame; ++x) {
      window.requestAnimationFrame =
        window[vendors[x] + 'RequestAnimationFrame'];
      window.cancelAnimationFrame =
        window[vendors[x] + 'CancelAnimationFrame'] ||
        window[vendors[x] + 'CancelRequestAnimationFrame'];
    }

    if (!window.requestAnimationFrame) {
      window.requestAnimationFrame = function (callback, element) {
        const currentTime = new Date().getTime();
        const timeToCall = Math.max(0, 16 - (currentTime - lastTime));
        const id = window.setTimeout(function () {
          callback(currentTime + timeToCall);
        }, timeToCall);
        lastTime = currentTime + timeToCall;
        return id;
      };
    }

    if (!window.cancelAnimationFrame) {
      window.cancelAnimationFrame = function (id) {
        clearTimeout(id);
      };
    }
  })();

  /**
   * @object Math Augmentation
   * @author Matthew Wagerfield
   */
  Math.PIM2 = Math.PI * 2;
  Math.PID2 = Math.PI / 2;
  Math.randomInRange = function (min, max) {
    return min + (max - min) * Math.random();
  };
  Math.clamp = function (value, min, max) {
    value = Math.max(value, min);
    value = Math.min(value, max);
    return value;
  };

  /**
   * @object Vector3
   * @author Matthew Wagerfield
   */
  FSS.Vector3 = {
    create(x, y, z) {
      const vector = new FSS.Array(3);
      this.set(vector, x, y, z);
      return vector;
    },
    clone(a) {
      const vector = this.create();
      this.copy(vector, a);
      return vector;
    },
    set(target, x, y, z) {
      target[0] = x || 0;
      target[1] = y || 0;
      target[2] = z || 0;
      return this;
    },
    setX(target, x) {
      target[0] = x || 0;
      return this;
    },
    setY(target, y) {
      target[1] = y || 0;
      return this;
    },
    setZ(target, z) {
      target[2] = z || 0;
      return this;
    },
    copy(target, a) {
      target[0] = a[0];
      target[1] = a[1];
      target[2] = a[2];
      return this;
    },
    add(target, a) {
      target[0] += a[0];
      target[1] += a[1];
      target[2] += a[2];
      return this;
    },
    addVectors(target, a, b) {
      target[0] = a[0] + b[0];
      target[1] = a[1] + b[1];
      target[2] = a[2] + b[2];
      return this;
    },
    addScalar(target, s) {
      target[0] += s;
      target[1] += s;
      target[2] += s;
      return this;
    },
    subtract(target, a) {
      target[0] -= a[0];
      target[1] -= a[1];
      target[2] -= a[2];
      return this;
    },
    subtractVectors(target, a, b) {
      target[0] = a[0] - b[0];
      target[1] = a[1] - b[1];
      target[2] = a[2] - b[2];
      return this;
    },
    subtractScalar(target, s) {
      target[0] -= s;
      target[1] -= s;
      target[2] -= s;
      return this;
    },
    multiply(target, a) {
      target[0] *= a[0];
      target[1] *= a[1];
      target[2] *= a[2];
      return this;
    },
    multiplyVectors(target, a, b) {
      target[0] = a[0] * b[0];
      target[1] = a[1] * b[1];
      target[2] = a[2] * b[2];
      return this;
    },
    multiplyScalar(target, s) {
      target[0] *= s;
      target[1] *= s;
      target[2] *= s;
      return this;
    },
    divide(target, a) {
      target[0] /= a[0];
      target[1] /= a[1];
      target[2] /= a[2];
      return this;
    },
    divideVectors(target, a, b) {
      target[0] = a[0] / b[0];
      target[1] = a[1] / b[1];
      target[2] = a[2] / b[2];
      return this;
    },
    divideScalar(target, s) {
      if (s !== 0) {
        target[0] /= s;
        target[1] /= s;
        target[2] /= s;
      } else {
        target[0] = 0;
        target[1] = 0;
        target[2] = 0;
      }
      return this;
    },
    cross(target, a) {
      const x = target[0];
      const y = target[1];
      const z = target[2];
      target[0] = y * a[2] - z * a[1];
      target[1] = z * a[0] - x * a[2];
      target[2] = x * a[1] - y * a[0];
      return this;
    },
    crossVectors(target, a, b) {
      target[0] = a[1] * b[2] - a[2] * b[1];
      target[1] = a[2] * b[0] - a[0] * b[2];
      target[2] = a[0] * b[1] - a[1] * b[0];
      return this;
    },
    min(target, value) {
      if (target[0] < value) {
        target[0] = value;
      }
      if (target[1] < value) {
        target[1] = value;
      }
      if (target[2] < value) {
        target[2] = value;
      }
      return this;
    },
    max(target, value) {
      if (target[0] > value) {
        target[0] = value;
      }
      if (target[1] > value) {
        target[1] = value;
      }
      if (target[2] > value) {
        target[2] = value;
      }
      return this;
    },
    clamp(target, min, max) {
      this.min(target, min);
      this.max(target, max);
      return this;
    },
    limit(target, min, max) {
      const length = this.length(target);
      if (min !== null && length < min) {
        this.setLength(target, min);
      } else if (max !== null && length > max) {
        this.setLength(target, max);
      }
      return this;
    },
    dot(a, b) {
      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    },
    normalise(target) {
      return this.divideScalar(target, this.length(target));
    },
    negate(target) {
      return this.multiplyScalar(target, -1);
    },
    distanceSquared(a, b) {
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      const dz = a[2] - b[2];
      return dx * dx + dy * dy + dz * dz;
    },
    distance(a, b) {
      return Math.sqrt(this.distanceSquared(a, b));
    },
    lengthSquared(a) {
      return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
    },
    length(a) {
      return Math.sqrt(this.lengthSquared(a));
    },
    setLength(target, l) {
      const length = this.length(target);
      if (length !== 0 && l !== length) {
        this.multiplyScalar(target, l / length);
      }
      return this;
    },
  };

  /**
   * @object Vector4
   * @author Matthew Wagerfield
   */
  FSS.Vector4 = {
    create(x, y, z, w) {
      const vector = new FSS.Array(4);
      this.set(vector, x, y, z);
      return vector;
    },
    set(target, x, y, z, w) {
      target[0] = x || 0;
      target[1] = y || 0;
      target[2] = z || 0;
      target[3] = w || 0;
      return this;
    },
    setX(target, x) {
      target[0] = x || 0;
      return this;
    },
    setY(target, y) {
      target[1] = y || 0;
      return this;
    },
    setZ(target, z) {
      target[2] = z || 0;
      return this;
    },
    setW(target, w) {
      target[3] = w || 0;
      return this;
    },
    add(target, a) {
      target[0] += a[0];
      target[1] += a[1];
      target[2] += a[2];
      target[3] += a[3];
      return this;
    },
    multiplyVectors(target, a, b) {
      target[0] = a[0] * b[0];
      target[1] = a[1] * b[1];
      target[2] = a[2] * b[2];
      target[3] = a[3] * b[3];
      return this;
    },
    multiplyScalar(target, s) {
      target[0] *= s;
      target[1] *= s;
      target[2] *= s;
      target[3] *= s;
      return this;
    },
    min(target, value) {
      if (target[0] < value) {
        target[0] = value;
      }
      if (target[1] < value) {
        target[1] = value;
      }
      if (target[2] < value) {
        target[2] = value;
      }
      if (target[3] < value) {
        target[3] = value;
      }
      return this;
    },
    max(target, value) {
      if (target[0] > value) {
        target[0] = value;
      }
      if (target[1] > value) {
        target[1] = value;
      }
      if (target[2] > value) {
        target[2] = value;
      }
      if (target[3] > value) {
        target[3] = value;
      }
      return this;
    },
    clamp(target, min, max) {
      this.min(target, min);
      this.max(target, max);
      return this;
    },
  };

  /**
   * @class Color
   * @author Matthew Wagerfield
   */
  FSS.Color = function (hex, opacity) {
    this.rgba = FSS.Vector4.create();
    this.hex = hex || '#000000';
    this.opacity = FSS.Utils.isNumber(opacity) ? opacity : 1;
    this.set(this.hex, this.opacity);
  };

  FSS.Color.prototype = {
    set(hex, opacity) {
      hex = hex.replace('#', '');
      const size = hex.length / 3;
      this.rgba[0] = parseInt(hex.substring(size * 0, size * 1), 16) / 255;
      this.rgba[1] = parseInt(hex.substring(size * 1, size * 2), 16) / 255;
      this.rgba[2] = parseInt(hex.substring(size * 2, size * 3), 16) / 255;
      this.rgba[3] = FSS.Utils.isNumber(opacity) ? opacity : this.rgba[3];
      return this;
    },
    hexify(channel) {
      let hex = Math.ceil(channel * 255).toString(16);
      if (hex.length === 1) {
        hex = '0' + hex;
      }
      return hex;
    },
    format() {
      const r = this.hexify(this.rgba[0]);
      const g = this.hexify(this.rgba[1]);
      const b = this.hexify(this.rgba[2]);
      this.hex = '#' + r + g + b;
      return this.hex;
    },
  };

  /**
   * @class Object
   * @author Matthew Wagerfield
   */
  FSS.Object = function () {
    this.position = FSS.Vector3.create();
  };

  FSS.Object.prototype = {
    setPosition(x, y, z) {
      FSS.Vector3.set(this.position, x, y, z);
      return this;
    },
  };

  /**
   * @class Light
   * @author Matthew Wagerfield
   */
  FSS.Light = function (ambient, diffuse) {
    FSS.Object.call(this);
    this.ambient = new FSS.Color(ambient || '#FFFFFF');
    this.diffuse = new FSS.Color(diffuse || '#FFFFFF');
    this.ray = FSS.Vector3.create();
  };

  FSS.Light.prototype = Object.create(FSS.Object.prototype);

  /**
   * @class Vertex
   * @author Matthew Wagerfield
   */
  FSS.Vertex = function (x, y, z) {
    this.position = FSS.Vector3.create(x, y, z);
  };

  FSS.Vertex.prototype = {
    setPosition(x, y, z) {
      FSS.Vector3.set(this.position, x, y, z);
      return this;
    },
  };

  /**
   * @class Triangle
   * @author Matthew Wagerfield
   */
  FSS.Triangle = function (a, b, c) {
    this.a = a || new FSS.Vertex();
    this.b = b || new FSS.Vertex();
    this.c = c || new FSS.Vertex();
    this.vertices = [this.a, this.b, this.c];
    this.u = FSS.Vector3.create();
    this.v = FSS.Vector3.create();
    this.centroid = FSS.Vector3.create();
    this.normal = FSS.Vector3.create();
    this.color = new FSS.Color();
    this.polygon = document.createElementNS(FSS.SVGNS, 'polygon');
    this.polygon.setAttributeNS(null, 'stroke-linejoin', 'round');
    this.polygon.setAttributeNS(null, 'stroke-miterlimit', '1');
    this.polygon.setAttributeNS(null, 'stroke-width', '1');
    this.computeCentroid();
    this.computeNormal();
  };

  FSS.Triangle.prototype = {
    computeCentroid() {
      this.centroid[0] =
        this.a.position[0] + this.b.position[0] + this.c.position[0];
      this.centroid[1] =
        this.a.position[1] + this.b.position[1] + this.c.position[1];
      this.centroid[2] =
        this.a.position[2] + this.b.position[2] + this.c.position[2];
      FSS.Vector3.divideScalar(this.centroid, 3);
      return this;
    },
    computeNormal() {
      FSS.Vector3.subtractVectors(this.u, this.b.position, this.a.position);
      FSS.Vector3.subtractVectors(this.v, this.c.position, this.a.position);
      FSS.Vector3.crossVectors(this.normal, this.u, this.v);
      FSS.Vector3.normalise(this.normal);
      return this;
    },
  };

  /**
   * @class Geometry
   * @author Matthew Wagerfield
   */
  FSS.Geometry = function () {
    this.vertices = [];
    this.triangles = [];
    this.dirty = false;
  };

  FSS.Geometry.prototype = {
    update() {
      if (this.dirty) {
        let t, triangle;
        for (t = this.triangles.length - 1; t >= 0; t--) {
          triangle = this.triangles[t];
          triangle.computeCentroid();
          triangle.computeNormal();
        }
        this.dirty = false;
      }
      return this;
    },
  };

  /**
   * @class Plane
   * @author Matthew Wagerfield
   */
  FSS.Plane = function (width, height, segments, slices) {
    FSS.Geometry.call(this);
    this.width = width || 100;
    this.height = height || 100;
    this.segments = segments || 4;
    this.slices = slices || 4;
    this.segmentWidth = this.width / this.segments;
    this.sliceHeight = this.height / this.slices;

    // Cache Variables
    let x,
      y,
      v0,
      v1,
      v2,
      v3,
      vertex,
      triangle,
      vertices = [],
      offsetX = this.width * -0.5,
      offsetY = this.height * 0.5;

    // Add Vertices
    for (x = 0; x <= this.segments; x++) {
      vertices.push([]);
      for (y = 0; y <= this.slices; y++) {
        vertex = new FSS.Vertex(
          offsetX + x * this.segmentWidth,
          offsetY - y * this.sliceHeight,
        );
        vertices[x].push(vertex);
        this.vertices.push(vertex);
      }
    }

    // Add Triangles
    for (x = 0; x < this.segments; x++) {
      for (y = 0; y < this.slices; y++) {
        v0 = vertices[x + 0][y + 0];
        v1 = vertices[x + 0][y + 1];
        v2 = vertices[x + 1][y + 0];
        v3 = vertices[x + 1][y + 1];
        const t0 = new FSS.Triangle(v0, v1, v2);
        const t1 = new FSS.Triangle(v2, v1, v3);
        this.triangles.push(t0, t1);
      }
    }
  };

  FSS.Plane.prototype = Object.create(FSS.Geometry.prototype);

  /**
   * @class Material
   * @author Matthew Wagerfield
   */
  FSS.Material = function (ambient, diffuse) {
    this.ambient = new FSS.Color(ambient || '#444444');
    this.diffuse = new FSS.Color(diffuse || '#FFFFFF');
    this.slave = new FSS.Color();
  };

  /**
   * @class Mesh
   * @author Matthew Wagerfield
   */
  FSS.Mesh = function (geometry, material) {
    FSS.Object.call(this);
    this.geometry = geometry || new FSS.Geometry();
    this.material = material || new FSS.Material();
    this.side = FSS.FRONT;
    this.visible = true;
  };

  FSS.Mesh.prototype = Object.create(FSS.Object.prototype);

  FSS.Mesh.prototype.update = function (lights, calculate) {
    let t, triangle, l, light, illuminance;

    // Update Geometry
    this.geometry.update();

    // Calculate the triangle colors
    if (calculate) {
      // Iterate through Triangles
      for (t = this.geometry.triangles.length - 1; t >= 0; t--) {
        triangle = this.geometry.triangles[t];

        // Reset Triangle Color
        FSS.Vector4.set(triangle.color.rgba);

        // Iterate through Lights
        for (l = lights.length - 1; l >= 0; l--) {
          light = lights[l];

          // Calculate Illuminance
          FSS.Vector3.subtractVectors(
            light.ray,
            light.position,
            triangle.centroid,
          );
          FSS.Vector3.normalise(light.ray);
          illuminance = FSS.Vector3.dot(triangle.normal, light.ray);
          if (this.side === FSS.FRONT) {
            illuminance = Math.max(illuminance, 0);
          } else if (this.side === FSS.BACK) {
            illuminance = Math.abs(Math.min(illuminance, 0));
          } else if (this.side === FSS.DOUBLE) {
            illuminance = Math.max(Math.abs(illuminance), 0);
          }

          // Calculate Ambient Light
          FSS.Vector4.multiplyVectors(
            this.material.slave.rgba,
            this.material.ambient.rgba,
            light.ambient.rgba,
          );
          FSS.Vector4.add(triangle.color.rgba, this.material.slave.rgba);

          // Calculate Diffuse Light
          FSS.Vector4.multiplyVectors(
            this.material.slave.rgba,
            this.material.diffuse.rgba,
            light.diffuse.rgba,
          );
          FSS.Vector4.multiplyScalar(this.material.slave.rgba, illuminance);
          FSS.Vector4.add(triangle.color.rgba, this.material.slave.rgba);
        }

        // Clamp & Format Color
        FSS.Vector4.clamp(triangle.color.rgba, 0, 1);
      }
    }
    return this;
  };

  /**
   * @class Scene
   * @author Matthew Wagerfield
   */
  FSS.Scene = function () {
    this.meshes = [];
    this.lights = [];
  };

  FSS.Scene.prototype = {
    add(object) {
      if (object instanceof FSS.Mesh && !~this.meshes.indexOf(object)) {
        this.meshes.push(object);
      } else if (object instanceof FSS.Light && !~this.lights.indexOf(object)) {
        this.lights.push(object);
      }
      return this;
    },
    remove(object) {
      if (object instanceof FSS.Mesh && ~this.meshes.indexOf(object)) {
        this.meshes.splice(this.meshes.indexOf(object), 1);
      } else if (object instanceof FSS.Light && ~this.lights.indexOf(object)) {
        this.lights.splice(this.lights.indexOf(object), 1);
      }
      return this;
    },
  };

  /**
   * @class Renderer
   * @author Matthew Wagerfield
   */
  FSS.Renderer = function () {
    this.width = 0;
    this.height = 0;
    this.halfWidth = 0;
    this.halfHeight = 0;
  };

  FSS.Renderer.prototype = {
    setSize(width, height) {
      if (this.width === width && this.height === height) return;
      this.width = width;
      this.height = height;
      this.halfWidth = this.width * 0.5;
      this.halfHeight = this.height * 0.5;
      return this;
    },
    clear() {
      return this;
    },
    render(scene) {
      return this;
    },
  };

  /**
   * @class Canvas Renderer
   * @author Matthew Wagerfield
   */
  FSS.CanvasRenderer = function () {
    FSS.Renderer.call(this);
    canvas = this.element = document.createElement('canvas');
    this.element.style.display = 'block';
    this.element.setAttribute('id', 'header-animation-canvas');
    this.context = this.element.getContext('2d');
    this.setSize(this.element.width, this.element.height);
  };

  FSS.CanvasRenderer.prototype = Object.create(FSS.Renderer.prototype);

  FSS.CanvasRenderer.prototype.setSize = function (width, height) {
    FSS.Renderer.prototype.setSize.call(this, width, height);
    this.element.width = width;
    this.element.height = height;
    this.context.setTransform(1, 0, 0, -1, this.halfWidth, this.halfHeight);
    return this;
  };

  FSS.CanvasRenderer.prototype.clear = function () {
    FSS.Renderer.prototype.clear.call(this);
    this.context.clearRect(
      -this.halfWidth,
      -this.halfHeight,
      this.width,
      this.height,
    );
    return this;
  };

  FSS.CanvasRenderer.prototype.render = function (scene) {
    FSS.Renderer.prototype.render.call(this, scene);
    let m, mesh, t, triangle, color;

    // Clear Context
    this.clear();

    // Configure Context
    this.context.lineJoin = 'round';
    this.context.lineWidth = 1;

    // Update Meshes
    for (m = scene.meshes.length - 1; m >= 0; m--) {
      mesh = scene.meshes[m];
      if (mesh.visible) {
        mesh.update(scene.lights, true);

        // Render Triangles
        for (t = mesh.geometry.triangles.length - 1; t >= 0; t--) {
          triangle = mesh.geometry.triangles[t];
          color = triangle.color.format();
          this.context.beginPath();
          this.context.moveTo(triangle.a.position[0], triangle.a.position[1]);
          this.context.lineTo(triangle.b.position[0], triangle.b.position[1]);
          this.context.lineTo(triangle.c.position[0], triangle.c.position[1]);
          this.context.closePath();
          this.context.strokeStyle = color;
          this.context.fillStyle = color;
          this.context.stroke();
          this.context.fill();
        }
      }
    }
    return this;
  };

  /**
   * @class WebGL Renderer
   * @author Matthew Wagerfield
   */
  FSS.WebGLRenderer = function () {
    FSS.Renderer.call(this);
    this.element = document.createElement('canvas');
    this.element.style.display = 'block';

    // Set initial vertex and light count
    this.vertices = null;
    this.lights = null;

    // Create parameters object
    const parameters = {
      preserveDrawingBuffer: false,
      premultipliedAlpha: true,
      antialias: true,
      stencil: true,
      alpha: true,
    };

    // Create and configure the gl context
    this.gl = this.getContext(this.element, parameters);

    // Set the internal support flag
    this.unsupported = !this.gl;

    // Setup renderer
    if (this.unsupported) {
      return 'WebGL is not supported by your browser.';
    } else {
      this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
      this.gl.enable(this.gl.DEPTH_TEST);
      this.setSize(this.element.width, this.element.height);
    }
  };

  FSS.WebGLRenderer.prototype = Object.create(FSS.Renderer.prototype);

  FSS.WebGLRenderer.prototype.getContext = function (canvas, parameters) {
    let context = false;
    try {
      if (!(context = canvas.getContext('experimental-webgl', parameters))) {
        throw 'Error creating WebGL context.';
      }
    } catch (error) {
      console.error(error);
    }
    return context;
  };

  FSS.WebGLRenderer.prototype.setSize = function (width, height) {
    FSS.Renderer.prototype.setSize.call(this, width, height);
    if (this.unsupported) return;

    // Set the size of the canvas element
    this.element.width = width;
    this.element.height = height;

    // Set the size of the gl viewport
    this.gl.viewport(0, 0, width, height);
    return this;
  };

  FSS.WebGLRenderer.prototype.clear = function () {
    FSS.Renderer.prototype.clear.call(this);
    if (this.unsupported) return;
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
    return this;
  };

  FSS.WebGLRenderer.prototype.render = function (scene) {
    FSS.Renderer.prototype.render.call(this, scene);
    if (this.unsupported) return;
    let m,
      mesh,
      t,
      tl,
      triangle,
      l,
      light,
      attribute,
      uniform,
      buffer,
      data,
      location,
      update = false,
      lights = scene.lights.length,
      index,
      v,
      vl,
      vetex,
      vertices = 0;

    // Clear context
    this.clear();

    // Build the shader program
    if (this.lights !== lights) {
      this.lights = lights;
      if (this.lights > 0) {
        this.buildProgram(lights);
      } else {
        return;
      }
    }

    // Update program
    if (!!this.program) {
      // Increment vertex counter
      for (m = scene.meshes.length - 1; m >= 0; m--) {
        mesh = scene.meshes[m];
        if (mesh.geometry.dirty) update = true;
        mesh.update(scene.lights, false);
        vertices += mesh.geometry.triangles.length * 3;
      }

      // Compare vertex counter
      if (update || this.vertices !== vertices) {
        this.vertices = vertices;

        // Build buffers
        for (attribute in this.program.attributes) {
          buffer = this.program.attributes[attribute];
          buffer.data = new FSS.Array(vertices * buffer.size);

          // Reset vertex index
          index = 0;

          // Update attribute buffer data
          for (m = scene.meshes.length - 1; m >= 0; m--) {
            mesh = scene.meshes[m];

            for (t = 0, tl = mesh.geometry.triangles.length; t < tl; t++) {
              triangle = mesh.geometry.triangles[t];

              for (v = 0, vl = triangle.vertices.length; v < vl; v++) {
                vertex = triangle.vertices[v];
                switch (attribute) {
                  case 'side':
                    this.setBufferData(index, buffer, mesh.side);
                    break;
                  case 'position':
                    this.setBufferData(index, buffer, vertex.position);
                    break;
                  case 'centroid':
                    this.setBufferData(index, buffer, triangle.centroid);
                    break;
                  case 'normal':
                    this.setBufferData(index, buffer, triangle.normal);
                    break;
                  case 'ambient':
                    this.setBufferData(
                      index,
                      buffer,
                      mesh.material.ambient.rgba,
                    );
                    break;
                  case 'diffuse':
                    this.setBufferData(
                      index,
                      buffer,
                      mesh.material.diffuse.rgba,
                    );
                    break;
                }
                index++;
              }
            }
          }

          // Upload attribute buffer data
          this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer.buffer);
          this.gl.bufferData(
            this.gl.ARRAY_BUFFER,
            buffer.data,
            this.gl.DYNAMIC_DRAW,
          );
          this.gl.enableVertexAttribArray(buffer.location);
          this.gl.vertexAttribPointer(
            buffer.location,
            buffer.size,
            this.gl.FLOAT,
            false,
            0,
            0,
          );
        }
      }

      // Build uniform buffers
      this.setBufferData(0, this.program.uniforms.resolution, [
        this.width,
        this.height,
        this.width,
      ]);
      for (l = lights - 1; l >= 0; l--) {
        light = scene.lights[l];
        this.setBufferData(
          l,
          this.program.uniforms.lightPosition,
          light.position,
        );
        this.setBufferData(
          l,
          this.program.uniforms.lightAmbient,
          light.ambient.rgba,
        );
        this.setBufferData(
          l,
          this.program.uniforms.lightDiffuse,
          light.diffuse.rgba,
        );
      }

      // Update uniforms
      for (uniform in this.program.uniforms) {
        buffer = this.program.uniforms[uniform];
        location = buffer.location;
        data = buffer.data;
        switch (buffer.structure) {
          case '3f':
            this.gl.uniform3f(location, data[0], data[1], data[2]);
            break;
          case '3fv':
            this.gl.uniform3fv(location, data);
            break;
          case '4fv':
            this.gl.uniform4fv(location, data);
            break;
        }
      }
    }

    // Draw those lovely triangles
    this.gl.drawArrays(this.gl.TRIANGLES, 0, this.vertices);
    return this;
  };

  FSS.WebGLRenderer.prototype.setBufferData = function (index, buffer, value) {
    if (FSS.Utils.isNumber(value)) {
      buffer.data[index * buffer.size] = value;
    } else {
      for (let i = value.length - 1; i >= 0; i--) {
        buffer.data[index * buffer.size + i] = value[i];
      }
    }
  };

  /**
   * Concepts taken from three.js WebGLRenderer
   * @see https://github.com/mrdoob/three.js/blob/master/src/renderers/WebGLRenderer.js
   */
  FSS.WebGLRenderer.prototype.buildProgram = function (lights) {
    if (this.unsupported) return;

    // Create shader source
    const vs = FSS.WebGLRenderer.VS(lights);
    const fs = FSS.WebGLRenderer.FS(lights);

    // Derive the shader fingerprint
    const code = vs + fs;

    // Check if the program has already been compiled
    if (!!this.program && this.program.code === code) return;

    // Create the program and shaders
    const program = this.gl.createProgram();
    const vertexShader = this.buildShader(this.gl.VERTEX_SHADER, vs);
    const fragmentShader = this.buildShader(this.gl.FRAGMENT_SHADER, fs);

    // Attach an link the shader
    this.gl.attachShader(program, vertexShader);
    this.gl.attachShader(program, fragmentShader);
    this.gl.linkProgram(program);

    // Add error handling
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      const error = this.gl.getError();
      const status = this.gl.getProgramParameter(
        program,
        this.gl.VALIDATE_STATUS,
      );
      console.error(
        'Could not initialise shader.\nVALIDATE_STATUS: ' +
          status +
          '\nERROR: ' +
          error,
      );
      return null;
    }

    // Delete the shader
    this.gl.deleteShader(fragmentShader);
    this.gl.deleteShader(vertexShader);

    // Set the program code
    program.code = code;

    // Add the program attributes
    program.attributes = {
      side: this.buildBuffer(program, 'attribute', 'aSide', 1, 'f'),
      position: this.buildBuffer(program, 'attribute', 'aPosition', 3, 'v3'),
      centroid: this.buildBuffer(program, 'attribute', 'aCentroid', 3, 'v3'),
      normal: this.buildBuffer(program, 'attribute', 'aNormal', 3, 'v3'),
      ambient: this.buildBuffer(program, 'attribute', 'aAmbient', 4, 'v4'),
      diffuse: this.buildBuffer(program, 'attribute', 'aDiffuse', 4, 'v4'),
    };

    // Add the program uniforms
    program.uniforms = {
      resolution: this.buildBuffer(
        program,
        'uniform',
        'uResolution',
        3,
        '3f',
        1,
      ),
      lightPosition: this.buildBuffer(
        program,
        'uniform',
        'uLightPosition',
        3,
        '3fv',
        lights,
      ),
      lightAmbient: this.buildBuffer(
        program,
        'uniform',
        'uLightAmbient',
        4,
        '4fv',
        lights,
      ),
      lightDiffuse: this.buildBuffer(
        program,
        'uniform',
        'uLightDiffuse',
        4,
        '4fv',
        lights,
      ),
    };

    // Set the renderer program
    this.program = program;

    // Enable program
    this.gl.useProgram(this.program);

    // Return the program
    return program;
  };

  FSS.WebGLRenderer.prototype.buildShader = function (type, source) {
    if (this.unsupported) return;

    // Create and compile shader
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    // Add error handling
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error(this.gl.getShaderInfoLog(shader));
      return null;
    }

    // Return the shader
    return shader;
  };

  FSS.WebGLRenderer.prototype.buildBuffer = function (
    program,
    type,
    identifier,
    size,
    structure,
    count,
  ) {
    const buffer = {
      buffer: this.gl.createBuffer(),
      size,
      structure,
      data: null,
    };

    // Set the location
    switch (type) {
      case 'attribute':
        buffer.location = this.gl.getAttribLocation(program, identifier);
        break;
      case 'uniform':
        buffer.location = this.gl.getUniformLocation(program, identifier);
        break;
    }

    // Create the buffer if count is provided
    if (!!count) {
      buffer.data = new FSS.Array(count * size);
    }

    // Return the buffer
    return buffer;
  };

  FSS.WebGLRenderer.VS = function (lights) {
    const shader = [
      // Precision
      'precision mediump float;',

      // Lights
      '#define LIGHTS ' + lights,

      // Attributes
      'attribute float aSide;',
      'attribute vec3 aPosition;',
      'attribute vec3 aCentroid;',
      'attribute vec3 aNormal;',
      'attribute vec4 aAmbient;',
      'attribute vec4 aDiffuse;',

      // Uniforms
      'uniform vec3 uResolution;',
      'uniform vec3 uLightPosition[LIGHTS];',
      'uniform vec4 uLightAmbient[LIGHTS];',
      'uniform vec4 uLightDiffuse[LIGHTS];',

      // Varyings
      'varying vec4 vColor;',

      // Main
      'void main() {',

      // Create color
      'vColor = vec4(0.0);',

      // Calculate the vertex position
      'vec3 position = aPosition / uResolution * 2.0;',

      // Iterate through lights
      'for (int i = 0; i < LIGHTS; i++) {',
      'vec3 lightPosition = uLightPosition[i];',
      'vec4 lightAmbient = uLightAmbient[i];',
      'vec4 lightDiffuse = uLightDiffuse[i];',

      // Calculate illuminance
      'vec3 ray = normalize(lightPosition - aCentroid);',
      'float illuminance = dot(aNormal, ray);',
      'if (aSide == 0.0) {',
      'illuminance = max(illuminance, 0.0);',
      '} else if (aSide == 1.0) {',
      'illuminance = abs(min(illuminance, 0.0));',
      '} else if (aSide == 2.0) {',
      'illuminance = max(abs(illuminance), 0.0);',
      '}',

      // Calculate ambient light
      'vColor += aAmbient * lightAmbient;',

      // Calculate diffuse light
      'vColor += aDiffuse * lightDiffuse * illuminance;',
      '}',

      // Clamp color
      'vColor = clamp(vColor, 0.0, 1.0);',

      // Set gl_Position
      'gl_Position = vec4(position, 1.0);',

      '}',

      // Return the shader
    ].join('\n');
    return shader;
  };

  FSS.WebGLRenderer.FS = function (lights) {
    const shader = [
      // Precision
      'precision mediump float;',

      // Varyings
      'varying vec4 vColor;',

      // Main
      'void main() {',

      // Set gl_FragColor
      'gl_FragColor = vColor;',

      '}',

      // Return the shader
    ].join('\n');
    return shader;
  };

  /**
   * @class SVG Renderer
   * @author Matthew Wagerfield
   */
  FSS.SVGRenderer = function () {
    FSS.Renderer.call(this);
    this.element = document.createElementNS(FSS.SVGNS, 'svg');
    this.element.setAttribute('xmlns', FSS.SVGNS);
    this.element.setAttribute('version', '1.1');
    this.element.style.display = 'block';
    this.setSize(300, 150);
  };

  FSS.SVGRenderer.prototype = Object.create(FSS.Renderer.prototype);

  FSS.SVGRenderer.prototype.setSize = function (width, height) {
    FSS.Renderer.prototype.setSize.call(this, width, height);
    this.element.setAttribute('width', width);
    this.element.setAttribute('height', height);
    return this;
  };

  FSS.SVGRenderer.prototype.clear = function () {
    FSS.Renderer.prototype.clear.call(this);
    for (let i = this.element.childNodes.length - 1; i >= 0; i--) {
      this.element.removeChild(this.element.childNodes[i]);
    }
    return this;
  };

  FSS.SVGRenderer.prototype.render = function (scene) {
    FSS.Renderer.prototype.render.call(this, scene);
    let m, mesh, t, triangle, points, style;

    // Update Meshes
    for (m = scene.meshes.length - 1; m >= 0; m--) {
      mesh = scene.meshes[m];
      if (mesh.visible) {
        mesh.update(scene.lights, true);

        // Render Triangles
        for (t = mesh.geometry.triangles.length - 1; t >= 0; t--) {
          triangle = mesh.geometry.triangles[t];
          if (triangle.polygon.parentNode !== this.element) {
            this.element.appendChild(triangle.polygon);
          }
          points = this.formatPoint(triangle.a) + ' ';
          points += this.formatPoint(triangle.b) + ' ';
          points += this.formatPoint(triangle.c);
          style = this.formatStyle(triangle.color.format());
          triangle.polygon.setAttributeNS(null, 'points', points);
          triangle.polygon.setAttributeNS(null, 'style', style);
        }
      }
    }
    return this;
  };

  FSS.SVGRenderer.prototype.formatPoint = function (vertex) {
    return (
      this.halfWidth +
      vertex.position[0] +
      ',' +
      (this.halfHeight - vertex.position[1])
    );
  };

  FSS.SVGRenderer.prototype.formatStyle = function (color) {
    let style = 'fill:' + color + ';';
    style += 'stroke:' + color + ';';
    return style;
  };

  ////////////////////////////////
  ////////////////////////////////
  ////////////////////////////////

  (function () {
    //------------------------------
    // Mesh Properties
    //------------------------------
    const MESH = {
      width: 1.8,
      height: 1.8,
      depth: 12,
      segments: 35,
      slices: 12,
      xRange: 0.5,
      yRange: 0.5,
      zRange: 1.0,
      ambient: '#555555',
      diffuse: '#696969',
      speed: 0.00005,
    };

    //------------------------------
    // Light Properties
    //------------------------------
    const LIGHT = {
      count: 2,
      xyScalar: 1,
      zOffset: 100,
      ambient: '#f4df4f',
      diffuse: '#def24b',
      speed: 0.00001,
      gravity: 500,
      dampening: 0.95,
      minLimit: 10,
      maxLimit: null,
      minDistance: 20,
      maxDistance: 400,
      autopilot: false,
      draw: false,
      bounds: FSS.Vector3.create(),
      step: FSS.Vector3.create(
        Math.randomInRange(0.2, 1.0),
        Math.randomInRange(0.2, 1.0),
        Math.randomInRange(0.2, 1.0),
      ),
    };

    //------------------------------
    // Render Properties
    //------------------------------

    const RENDER = {
      renderer: 'canvas',
    };

    //------------------------------
    // Global Properties
    //------------------------------
    let now,
      start = Date.now();
    const center = FSS.Vector3.create();
    const attractor = FSS.Vector3.create();
    const container = document.getElementById(containerID);
    const output = document.getElementById(containerID);
    let renderer, scene, mesh, geometry, material;
    let canvasRenderer;
    let gui, autopilotController;

    //------------------------------
    // Methods
    //------------------------------
    function initialise() {
      createRenderer();
      createScene();
      createMesh();
      createLights();
      addEventListeners();
      resize(container.offsetWidth, container.offsetHeight);
      animate();
    }

    function createRenderer() {
      canvasRenderer = new FSS.CanvasRenderer();
      setRenderer(RENDER.renderer);
    }

    function setRenderer(index) {
      if (renderer) {
        output.removeChild(renderer.element);
      }

      renderer = canvasRenderer;

      renderer.setSize(container.offsetWidth, container.offsetHeight);
      output.appendChild(renderer.element);
    }

    function createScene() {
      scene = new FSS.Scene();
    }

    function createMesh() {
      scene.remove(mesh);
      renderer.clear();
      geometry = new FSS.Plane(
        MESH.width * renderer.width,
        MESH.height * renderer.height,
        MESH.segments,
        MESH.slices,
      );
      material = new FSS.Material(MESH.ambient, MESH.diffuse);
      mesh = new FSS.Mesh(geometry, material);
      scene.add(mesh);

      // Augment vertices for animation
      let v, vertex;
      for (v = geometry.vertices.length - 1; v >= 0; v--) {
        vertex = geometry.vertices[v];
        vertex.anchor = FSS.Vector3.clone(vertex.position);
        vertex.step = FSS.Vector3.create(
          Math.randomInRange(0.2, 1.0),
          Math.randomInRange(0.2, 1.0),
          Math.randomInRange(0.2, 1.0),
        );
        vertex.time = Math.randomInRange(0, Math.PIM2);
      }
    }

    function createLights() {
      let l, light;
      for (l = scene.lights.length - 1; l >= 0; l--) {
        light = scene.lights[l];
        scene.remove(light);
      }
      renderer.clear();
      for (l = 0; l < LIGHT.count; l++) {
        light = new FSS.Light(LIGHT.ambient, LIGHT.diffuse);
        light.ambientHex = light.ambient.format();
        light.diffuseHex = light.diffuse.format();
        scene.add(light);

        // Augment light for animation
        light.mass = Math.randomInRange(0.5, 1);
        light.velocity = FSS.Vector3.create();
        light.acceleration = FSS.Vector3.create();
        light.force = FSS.Vector3.create();

        // Ring SVG Circle
        light.ring = document.createElementNS(FSS.SVGNS, 'circle');
        light.ring.setAttributeNS(null, 'stroke', light.ambientHex);
        light.ring.setAttributeNS(null, 'stroke-width', '0.5');
        light.ring.setAttributeNS(null, 'fill', 'none');
        light.ring.setAttributeNS(null, 'r', '10');

        // Core SVG Circle
        light.core = document.createElementNS(FSS.SVGNS, 'circle');
        light.core.setAttributeNS(null, 'fill', light.diffuseHex);
        light.core.setAttributeNS(null, 'r', '4');
      }
    }

    function resize(width, height) {
      renderer.setSize(width, height);
      FSS.Vector3.set(center, renderer.halfWidth, renderer.halfHeight);
      createMesh();
    }

    function animate() {
      now = Date.now() - start;
      update();
      render();
      setTimeout(() => requestAnimationFrame(animate), 160);
    }

    function update() {
      let ox,
        oy,
        oz,
        l,
        light,
        v,
        vertex,
        offset = MESH.depth / 2;

      // Update Bounds
      FSS.Vector3.copy(LIGHT.bounds, center);
      FSS.Vector3.multiplyScalar(LIGHT.bounds, LIGHT.xyScalar);

      // Update Attractor
      FSS.Vector3.setZ(attractor, LIGHT.zOffset);

      // Overwrite the Attractor position
      if (LIGHT.autopilot) {
        ox = Math.sin(LIGHT.step[0] * now * LIGHT.speed);
        oy = Math.cos(LIGHT.step[1] * now * LIGHT.speed);
        FSS.Vector3.set(
          attractor,
          LIGHT.bounds[0] * ox,
          LIGHT.bounds[1] * oy,
          LIGHT.zOffset,
        );
      }

      // Animate Lights
      for (l = scene.lights.length - 1; l >= 0; l--) {
        light = scene.lights[l];

        // Reset the z position of the light
        FSS.Vector3.setZ(light.position, LIGHT.zOffset);

        // Calculate the force Luke!
        const D = Math.clamp(
          FSS.Vector3.distanceSquared(light.position, attractor),
          LIGHT.minDistance,
          LIGHT.maxDistance,
        );
        const F = (LIGHT.gravity * light.mass) / D;
        FSS.Vector3.subtractVectors(light.force, attractor, light.position);
        FSS.Vector3.normalise(light.force);
        FSS.Vector3.multiplyScalar(light.force, F);

        // Update the light position
        FSS.Vector3.set(light.acceleration);
        FSS.Vector3.add(light.acceleration, light.force);
        FSS.Vector3.add(light.velocity, light.acceleration);
        FSS.Vector3.multiplyScalar(light.velocity, LIGHT.dampening);
        FSS.Vector3.limit(light.velocity, LIGHT.minLimit, LIGHT.maxLimit);
        FSS.Vector3.add(light.position, light.velocity);
      }

      // Animate Vertices
      for (v = geometry.vertices.length - 1; v >= 0; v--) {
        vertex = geometry.vertices[v];
        ox = Math.sin(vertex.time + vertex.step[0] * now * MESH.speed);
        oy = Math.cos(vertex.time + vertex.step[1] * now * MESH.speed);
        oz = Math.sin(vertex.time + vertex.step[2] * now * MESH.speed);
        FSS.Vector3.set(
          vertex.position,
          MESH.xRange * geometry.segmentWidth * ox,
          MESH.yRange * geometry.sliceHeight * oy,
          MESH.zRange * offset * oz - offset,
        );
        FSS.Vector3.add(vertex.position, vertex.anchor);
      }

      // Set the Geometry to dirty
      geometry.dirty = true;
    }

    function render() {
      renderer.render(scene);

      // Draw Lights
      if (LIGHT.draw) {
        let l, lx, ly, light;
        for (l = scene.lights.length - 1; l >= 0; l--) {
          light = scene.lights[l];
          lx = light.position[0];
          ly = light.position[1];
          renderer.context.lineWidth = 0.5;
          renderer.context.beginPath();
          renderer.context.arc(lx, ly, 10, 0, Math.PIM2);
          renderer.context.strokeStyle = light.ambientHex;
          renderer.context.stroke();
          renderer.context.beginPath();
          renderer.context.arc(lx, ly, 4, 0, Math.PIM2);
          renderer.context.fillStyle = light.diffuseHex;
          renderer.context.fill();
        }
      }
    }

    function addEventListeners() {
      window.addEventListener('resize', onWindowResize);
      //container.addEventListener('mousemove', onMouseMove);
    }

    //------------------------------
    // Callbacks
    //------------------------------

    function onMouseMove(event) {
      FSS.Vector3.set(attractor, event.x, renderer.height - event.y);
      FSS.Vector3.subtract(attractor, center);
    }

    function onWindowResize(event) {
      resize(container.offsetWidth, container.offsetHeight);
      render();
    }

    // Let there be light!
    initialise();
  })();

  return {
    getCanvas: () => canvas,
  };
}
