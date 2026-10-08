import * as THREE from 'three';

export const STYLES = {
  coupe:  { len: 4.4, wid: 1.86, hgt: 1.0,  wing: 'small', scoop: false },
  muscle: { len: 4.7, wid: 1.95, hgt: 1.08, wing: null,    scoop: true },
  proto:  { len: 4.6, wid: 2.0,  hgt: 0.86, wing: 'big',   scoop: false },
};

export const WHEEL_R = 0.34;

// Side profiles (z along the car, y up) for a 4.4 m reference length.
const BODY = [[-2.2, 0.32], [2.12, 0.32], [2.25, 0.5], [2.05, 0.72], [0.9, 0.86], [-1.5, 0.9], [-2.18, 0.95], [-2.28, 0.62]];
const CABIN = [[1.0, 0.84], [0.1, 1.26], [-0.95, 1.28], [-1.75, 0.9], [-1.8, 0.84]];

function extrudeProfile(profile, sx, sy, width, bevel) {
  const shape = new THREE.Shape();
  profile.forEach(([z, y], i) => (i ? shape.lineTo(z * sx, y * sy) : shape.moveTo(z * sx, y * sy)));
  shape.closePath();
  const depth = width - bevel * 2;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 4,
  });
  // shape x -> car z, extrusion -> car x, centred
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

function shadowAll(obj) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
}

// Builds a stylised car. Front faces +z. Returns handles for animation.
export function buildCarModel(spec, color) {
  const st = STYLES[spec.style];
  const L = st.len, W = st.wid, H = st.hgt, sx = L / 4.4;

  const group = new THREE.Group();
  const chassis = new THREE.Group();
  group.add(chassis);

  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.75 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b1118, metalness: 0.2, roughness: 0.04, clearcoat: 1 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4e0, emissiveIntensity: 1.6 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1010, emissiveIntensity: 0.8 });

  const body = new THREE.Mesh(extrudeProfile(BODY, sx, H, W, 0.08), paint);
  chassis.add(body);

  const cabin = new THREE.Mesh(extrudeProfile(CABIN, sx, H, W * 0.74, 0.05), glass);
  chassis.add(cabin);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, 0.05, 1.0 * sx), paint);
  roof.position.set(0, 1.27 * H + 0.02, -0.42 * sx);
  chassis.add(roof);

  // lower trim, splitter, diffuser
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, 0.12, L * 0.86), dark);
  skirt.position.y = 0.33 * H;
  chassis.add(skirt);
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(W * 0.96, 0.04, 0.3), dark);
  splitter.position.set(0, 0.29 * H, L / 2 - 0.05);
  chassis.add(splitter);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(W * 0.5, 0.14, 0.05), dark);
  grille.position.set(0, 0.42 * H, 2.25 * sx + 0.08);
  chassis.add(grille);

  // lights (sit just proud of the bevelled body surface)
  for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.1), headMat);
    hl.position.set(s * W * 0.31, 0.6 * H, 2.15 * sx + 0.1);
    hl.rotation.x = -0.75;
    chassis.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.06), brakeMat);
    tl.position.set(s * W * 0.3, 0.78 * H, -2.23 * sx - 0.12);
    chassis.add(tl);
  }
  // exhaust
  for (const s of spec.style === 'muscle' ? [-1, 1] : [1]) {
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.2, 10).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 1, roughness: 0.3 }));
    ex.position.set(s * W * 0.28, 0.38 * H, -2.28 * sx);
    chassis.add(ex);
  }

  if (st.wing) {
    const big = st.wing === 'big';
    const wy = 0.95 * H + (big ? 0.42 : 0.2);
    const wz = -1.95 * sx;
    for (const s of [-1, 1]) {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.05, wy - 0.9 * H, 0.14), dark);
      strut.position.set(s * W * 0.28, (wy + 0.9 * H) / 2, wz);
      chassis.add(strut);
      if (big) {
        const plate = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.55), paint);
        plate.position.set(s * W * 0.48, wy, wz);
        chassis.add(plate);
      }
    }
    const wing = new THREE.Mesh(new THREE.BoxGeometry(W * (big ? 0.98 : 0.86), 0.05, big ? 0.5 : 0.32), big ? dark : paint);
    wing.position.set(0, wy, wz);
    wing.rotation.x = 0.08;
    chassis.add(wing);
  }
  if (st.scoop) {
    const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.14, 0.9), dark);
    scoop.position.set(0, 0.86 * H + 0.03, 1.05 * sx);
    chassis.add(scoop);
  }

  // racing stripe / number roundel
  const roundel = new THREE.Mesh(new THREE.CircleGeometry(0.32, 24), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
  for (const s of [-1, 1]) {
    const r = roundel.clone();
    r.position.set(s * (W / 2 + 0.005), 0.58 * H, 0.1);
    r.rotation.y = s * Math.PI / 2;
    chassis.add(r);
  }

  // wheels
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 1, roughness: 0.3 });
  const tireGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.27, 24).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.23, 0.23, 0.28, 16).rotateZ(Math.PI / 2);
  const spokeA = new THREE.BoxGeometry(0.285, 0.42, 0.06);
  const spokeB = new THREE.BoxGeometry(0.285, 0.06, 0.42);

  const wheelX = W / 2 - 0.12;
  const frontZ = 0.31 * L, rearZ = -0.3 * L;
  const spins = [], pivots = [];
  for (const [x, z, front] of [[wheelX, frontZ, true], [-wheelX, frontZ, true], [wheelX, rearZ, false], [-wheelX, rearZ, false]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, WHEEL_R, z);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(tireGeo, tireMat), new THREE.Mesh(rimGeo, rimMat), new THREE.Mesh(spokeA, rimMat), new THREE.Mesh(spokeB, rimMat));
    pivot.add(spin);
    group.add(pivot);
    spins.push(spin);
    if (front) pivots.push(pivot);
  }

  shadowAll(group);
  return { group, chassis, spins, pivots, brakeMat, headMat, color, dims: { L, W, H, wheelX, rearZ, frontZ } };
}

export function disposeModel(model) {
  model.group.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    }
  });
  model.group.removeFromParent();
}
