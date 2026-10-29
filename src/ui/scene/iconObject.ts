import * as THREE from 'three';
import { ShapeBlender, animationFrame, type IconModel, type IconSys, type SaveKind } from '../../core';

// Icons are modeled with -y as "up" and the camera looking down +z.
// Rotating 180° around x, (x, y, z) -> (x, -y, -z), gives three.js's y-up
// convention without mirroring (so triangle winding is unchanged).
function toWorld(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i]!;
    out[i + 1] = -src[i + 1]!;
    out[i + 2] = -src[i + 2]!;
  }
  return out;
}

const vertexShader = /* glsl */ `
  attribute vec4 vertexColor;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vColor;
  void main() {
    vec3 p = position;
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vColor = vertexColor.rgb;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// Same lighting as the PS2 browser (and ps2mc-browser): ambient plus three
// directional lights from icon.sys, times the texture or vertex color.
const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform bool hasMap;
  uniform vec3 ambient;
  uniform vec3 lightDir[3];
  uniform vec3 lightColor[3];
  uniform float highlight;
  uniform float opacity;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vColor;
  void main() {
    vec3 base = hasMap ? texture2D(map, vUv).rgb : vColor;
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 diffuse = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      diffuse += max(dot(n, -lightDir[i]), 0.0) * lightColor[i];
    }
    vec3 color = (ambient + diffuse) * base;
    gl_FragColor = vec4(color * (1.0 + highlight), opacity);
  }
`;

const DEFAULT_LIGHTS = {
  ambient: [0.5, 0.5, 0.5],
  dirs: [
    [0.5, 0.5, 0.5],
    [0, -0.4, -0.1],
    [-0.5, -0.5, 0.5],
  ],
  colors: [
    [0.4, 0.4, 0.4],
    [0.3, 0.3, 0.3],
    [0.2, 0.2, 0.2],
  ],
};

function lightingFrom(sys: IconSys | undefined) {
  if (!sys) return DEFAULT_LIGHTS;
  const total =
    sys.ambientLight.slice(0, 3).reduce((a, b) => a + b, 0) +
    sys.lightColors.flatMap((c) => c.slice(0, 3)).reduce((a, b) => a + b, 0);
  // A few games leave the lights at zero; the icon would render black.
  if (!(total > 0.05)) return DEFAULT_LIGHTS;
  return {
    ambient: sys.ambientLight.slice(0, 3),
    dirs: sys.lightDirections.map((d) => d.slice(0, 3)),
    colors: sys.lightColors.map((c) => c.slice(0, 3)),
  };
}

/** A save's 3D icon. `animate` morphs it between its shapes. */
export class IconObject {
  readonly object: THREE.Mesh;
  readonly shapeCount: number;
  readonly model: IconModel;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  /** Each shape's vertex positions, already flipped to three.js axes. */
  private readonly shapes: Float32Array[];
  private readonly position: THREE.BufferAttribute;
  private readonly blender: ShapeBlender;
  private readonly lastWeights: Float32Array;
  private readonly texture?: THREE.DataTexture;

  constructor(model: IconModel, sys: IconSys | undefined) {
    this.model = model;
    this.shapeCount = model.shapes.length;
    this.geometry = new THREE.BufferGeometry();
    this.shapes = model.shapes.map(toWorld);
    this.position = new THREE.BufferAttribute(this.shapes[0]!.slice(), 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.position);
    this.blender = new ShapeBlender(model.animation, this.shapeCount);
    this.lastWeights = new Float32Array(this.shapeCount).fill(Number.NaN);
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(toWorld(model.normals), 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(model.uvs, 2));
    this.geometry.setAttribute('vertexColor', new THREE.BufferAttribute(model.colors, 4, true));
    // Bounds over all shapes, so the icon never pokes outside its cell mid-animation.
    const box = new THREE.Box3();
    for (const s of this.shapes) box.union(new THREE.Box3().setFromArray(s));
    this.geometry.boundingBox = box;
    this.geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());

    if (model.texture) {
      this.texture = new THREE.DataTexture(model.texture, 128, 128, THREE.RGBAFormat);
      this.texture.magFilter = THREE.LinearFilter;
      this.texture.minFilter = THREE.LinearFilter;
      this.texture.needsUpdate = true;
    }

    const light = lightingFrom(sys);
    const v3 = (a: number[]) => new THREE.Vector3(a[0], -a[1]!, -a[2]!); // same flip as the geometry
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
      uniforms: {
        map: { value: this.texture ?? null },
        hasMap: { value: !!this.texture },
        ambient: { value: new THREE.Vector3(...(light.ambient as [number, number, number])) },
        lightDir: { value: light.dirs.map((d) => v3(d).normalize()) },
        lightColor: { value: light.colors.map((c) => new THREE.Vector3(...(c as [number, number, number]))) },
        highlight: { value: 0 },
        opacity: { value: 1 },
      },
      transparent: true,
    });
    this.object = new THREE.Mesh(this.geometry, this.material);
  }

  get bounds(): THREE.Box3 {
    return this.geometry.boundingBox!;
  }

  /** Whether the icon has more than one shape to morph between. */
  get animated(): boolean {
    return this.blender.animated;
  }

  /** Show the icon as it is `seconds` into its animation loop. */
  animate(seconds: number): void {
    const w = this.blender.weights(animationFrame(this.model.animation, seconds));
    let changed = false;
    for (let i = 0; i < w.length; i++) {
      if (Math.abs(w[i]! - this.lastWeights[i]!) > 1e-4 || Number.isNaN(this.lastWeights[i]!)) changed = true;
    }
    if (!changed) return;
    this.lastWeights.set(w);
    const out = this.position.array as Float32Array;
    out.fill(0);
    for (let s = 0; s < this.shapeCount; s++) {
      const weight = w[s]!;
      if (weight === 0) continue;
      const src = this.shapes[s]!;
      for (let i = 0; i < out.length; i++) out[i]! += src[i]! * weight;
    }
    this.position.needsUpdate = true;
  }

  setHighlight(amount: number): void {
    this.material.uniforms.highlight!.value = amount;
  }

  setOpacity(opacity: number): void {
    this.material.uniforms.opacity!.value = opacity;
    this.object.visible = opacity > 0.01;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture?.dispose();
  }
}

const PLACEHOLDER_STYLE: Record<SaveKind, { label: string; color: string }> = {
  ps2: { label: 'PS2', color: '#3b4f8a' },
  ps1: { label: 'PS', color: '#6b6f76' },
  pocketstation: { label: 'PKT', color: '#6b6f76' },
  unknown: { label: '?', color: '#5a4a6a' },
  file: { label: 'FILE', color: '#4a5a4a' },
};

/** Flat tile for saves without a usable 3D icon (PS1 saves, broken icons, loose files). */
export class PlaceholderObject {
  readonly object: THREE.Mesh;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly geometry: THREE.BoxGeometry;

  readonly animated = false;

  constructor(kind: SaveKind) {
    const { label, color } = PLACEHOLDER_STYLE[kind];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const g = canvas.getContext('2d')!;
    g.fillStyle = color;
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 4;
    g.strokeRect(6, 6, 116, 116);
    g.fillStyle = '#fff';
    g.font = `bold ${label.length > 3 ? 30 : 40}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 64, 66);
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true });
    this.geometry = new THREE.BoxGeometry(2.4, 2.4, 0.3);
    this.object = new THREE.Mesh(this.geometry, this.material);
  }

  animate(): void {
    // Flat tiles don't animate.
  }

  setHighlight(amount: number): void {
    this.material.color.setScalar(1 + amount * 0.3);
  }

  setOpacity(opacity: number): void {
    this.material.opacity = opacity;
    this.object.visible = opacity > 0.01;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

export type GridVisual = IconObject | PlaceholderObject;
