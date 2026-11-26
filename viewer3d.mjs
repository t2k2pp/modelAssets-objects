import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

let activeState = null;
let lastRigMotion = "walk";
let lastGenericMotion = "g_walk";
let lastSimpleMotion = "rest";
let lastMotionSpeed = 1.0;
let lastShowSkel = false;

const SPEED_STEPS = [1.0, 1.5, 0.5];
const MOTION_SPEED_M = { walk: 0.85, run: 1.9, g_walk: 0.85, bounce: 0.85 };
const GRID_CELL_M = 0.25; // GridHelper(3.0, 12) => 3.0 / 12
const _vAxisX = new THREE.Vector3(1, 0, 0);
const _vAxisY = new THREE.Vector3(0, 1, 0);
const _vAxisZ = new THREE.Vector3(0, 0, 1);
const _eulerTmp = new THREE.Euler(0, 0, 0, "YXZ");
const _qTmpA = new THREE.Quaternion();
const _qTmpB = new THREE.Quaternion();
const _qTmpC = new THREE.Quaternion();

function qAxisAngle(axis, angle) {
  return new THREE.Quaternion().setFromAxisAngle(axis, angle);
}

function qEulerYXZ(rx = 0, ry = 0, rz = 0) {
  _eulerTmp.set(rx, ry, rz, "YXZ");
  return new THREE.Quaternion().setFromEuler(_eulerTmp);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function canonicalBoneName(name) {
  if (!name) return "";
  return name.replace(/^mixamorig:?/, "");
}

function computeTargetLocalQ(info, qWorldDelta, out = new THREE.Quaternion()) {
  return out
    .copy(info.parentRestWorldQInv)
    .multiply(qWorldDelta)
    .multiply(info.parentRestWorldQ)
    .multiply(info.restLocalQ);
}

function buildRigProfile(root) {
  root.updateMatrixWorld(true);
  const boneRest = {};
  root.traverse((obj) => {
    if (!obj.isBone || !obj.parent) return;
    const cname = canonicalBoneName(obj.name);
    if (!cname || boneRest[cname]) return;
    const parentWorldQ = new THREE.Quaternion();
    obj.parent.getWorldQuaternion(parentWorldQ);
    boneRest[cname] = {
      name: cname,
      bone: obj,
      restLocalQ: obj.quaternion.clone(),
      parentRestWorldQ: parentWorldQ,
      parentRestWorldQInv: parentWorldQ.clone().invert(),
    };
  });

  const hasRig = Boolean(
    boneRest.Hips && (boneRest.LeftUpLeg || boneRest.RightUpLeg || boneRest.Spine)
  );

  function detectArmRest(sideKey) {
    const prefix = sideKey === "L" ? "Left" : "Right";
    const armInfo = boneRest[prefix + "Arm"];
    const foreInfo = boneRest[prefix + "ForeArm"];
    const handInfo = boneRest[prefix + "Hand"];
    const signX = sideKey === "L" ? 1 : -1;
    let restDrop = 0;
    let restElbowBend = 0;
    let elbowAxis = new THREE.Vector3(0, sideKey === "L" ? -1 : 1, 0);
    if (armInfo && foreInfo) {
      const pArm = new THREE.Vector3();
      const pFore = new THREE.Vector3();
      armInfo.bone.getWorldPosition(pArm);
      foreInfo.bone.getWorldPosition(pFore);
      const v = pFore.clone().sub(pArm);
      const vXY = new THREE.Vector3(v.x, v.y, 0);
      if (vXY.lengthSq() > 1e-6) {
        vXY.normalize();
        restDrop = Math.atan2(-vXY.y, Math.max(1e-3, signX * vXY.x));
        const cross = new THREE.Vector3().crossVectors(vXY, _vAxisZ);
        if (cross.lengthSq() > 1e-6) elbowAxis = cross.normalize();
      }
      if (handInfo) {
        const pHand = new THREE.Vector3();
        handInfo.bone.getWorldPosition(pHand);
        const vLower = pHand.clone().sub(pFore);
        if (v.lengthSq() > 1e-6 && vLower.lengthSq() > 1e-6) {
          v.normalize();
          vLower.normalize();
          if (vLower.z > v.z + 0.05) {
            restElbowBend = clamp(Math.acos(clamp(v.dot(vLower), -1, 1)), 0, 1.0);
          }
        }
      }
    }
    return { restDrop, restElbowBend, elbowAxis };
  }

  const armL = detectArmRest("L");
  const armR = detectArmRest("R");

  return {
    hasRig,
    boneRest,
    arms: {
      L: { prefix: "Left", sign: -1, restDrop: armL.restDrop, restElbowBend: armL.restElbowBend, elbowAxis: armL.elbowAxis },
      R: { prefix: "Right", sign: 1, restDrop: armR.restDrop, restElbowBend: armR.restElbowBend, elbowAxis: armR.elbowAxis },
    },
  };
}

function setArmPose(profile, targets, sideKey, targetDrop, swingX, elbowBend, twistY = 0, wristWave = 0) {
  const cfg = profile.arms[sideKey];
  const deltaDrop = targetDrop - cfg.restDrop;
  const shDrop = clamp(deltaDrop * 0.2, -0.22, 0.22);
  const armDrop = deltaDrop - shDrop;

  if (profile.boneRest[cfg.prefix + "Shoulder"]) {
    targets[cfg.prefix + "Shoulder"] = qAxisAngle(_vAxisZ, cfg.sign * shDrop);
  }
  if (profile.boneRest[cfg.prefix + "Arm"]) {
    // Drop/lift along world Z from rest orientation, then swing/roll around world X, then yaw around world Y.
    const qDrop = _qTmpA.setFromAxisAngle(_vAxisZ, cfg.sign * armDrop);
    const qSwing = _qTmpB.setFromAxisAngle(_vAxisX, swingX);
    const qTwist = _qTmpC.setFromAxisAngle(_vAxisY, twistY);
    targets[cfg.prefix + "Arm"] = new THREE.Quaternion()
      .copy(qTwist)
      .multiply(qSwing)
      .multiply(qDrop);
  }
  if (profile.boneRest[cfg.prefix + "ForeArm"]) {
    const deltaBend = Math.max(0, elbowBend - (cfg.restElbowBend || 0));
    targets[cfg.prefix + "ForeArm"] = qAxisAngle(cfg.elbowAxis, deltaBend);
  }
  if (profile.boneRest[cfg.prefix + "Hand"] && Math.abs(wristWave) > 1e-5) {
    targets[cfg.prefix + "Hand"] = qAxisAngle(cfg.elbowAxis, wristWave);
  }
}

function evaluateRigMotion(profile, mode, t, modelH) {
  const targets = {};
  let rootYOffset = 0;

  if (mode === "idle") {
    const br = Math.sin(t * 1.8);
    const sway = Math.sin(t * 0.9);
    const look = Math.sin(t * 0.65);
    setArmPose(profile, targets, "L", 1.24, 0.03 * br, 0.16);
    setArmPose(profile, targets, "R", 1.24, 0.03 * br, 0.16);
    targets.Hips = qEulerYXZ(0, 0.02 * sway, 0.022 * sway);
    targets.Spine = qEulerYXZ(0.02 * br, 0, -0.012 * sway);
    targets.Spine1 = qEulerYXZ(0.018 * br, 0, -0.01 * sway);
    targets.Spine2 = qEulerYXZ(0.015 * br, 0, 0);
    targets.Neck = qEulerYXZ(0.015 * Math.sin(t * 1.1), 0.06 * look, 0);
    targets.Head = qEulerYXZ(0.02 * Math.sin(t * 1.1), 0.09 * look, 0);
    targets.LeftUpLeg = qEulerYXZ(0, 0, -0.025);
    targets.RightUpLeg = qEulerYXZ(0, 0, 0.025);
  } else if (mode === "walk") {
    const p = t * 0.95 * Math.PI * 2;
    const s = Math.sin(p);
    const c = Math.cos(p);
    targets.LeftUpLeg = qEulerYXZ(-0.42 * s, 0, -0.02);
    targets.RightUpLeg = qEulerYXZ(0.42 * s, 0, 0.02);
    targets.LeftLeg = qEulerYXZ(Math.max(0, 0.08 + 0.56 * Math.max(0, c) + 0.14 * Math.max(0, -s)), 0, 0);
    targets.RightLeg = qEulerYXZ(Math.max(0, 0.08 + 0.56 * Math.max(0, -c) + 0.14 * Math.max(0, s)), 0, 0);
    targets.LeftFoot = qEulerYXZ(-0.16 * c - 0.08 * s, 0, 0);
    targets.RightFoot = qEulerYXZ(0.16 * c + 0.08 * s, 0, 0);
    setArmPose(profile, targets, "L", 1.18, 0.38 * s, 0.22 + 0.22 * Math.max(0, -s));
    setArmPose(profile, targets, "R", 1.18, -0.38 * s, 0.22 + 0.22 * Math.max(0, s));
    targets.Hips = qEulerYXZ(0.02, -0.09 * s, -0.035 * s);
    targets.Spine = qEulerYXZ(0.03, 0.05 * s, 0.02 * s);
    targets.Spine1 = qEulerYXZ(0.02, 0.05 * s, 0);
    targets.Spine2 = qEulerYXZ(0.01, 0.04 * s, 0);
    targets.Neck = qEulerYXZ(-0.02, -0.04 * s, 0);
    targets.Head = qEulerYXZ(-0.02, -0.04 * s, 0);
    rootYOffset = modelH * 0.022 * (0.5 + 0.5 * Math.cos(2 * p));
  } else if (mode === "run") {
    const p = t * 1.55 * Math.PI * 2;
    const s = Math.sin(p);
    const c = Math.cos(p);
    targets.LeftUpLeg = qEulerYXZ(-0.72 * s - 0.08, 0, -0.02);
    targets.RightUpLeg = qEulerYXZ(0.72 * s - 0.08, 0, 0.02);
    targets.LeftLeg = qEulerYXZ(Math.max(0, 0.15 + 0.95 * Math.max(0, c) + 0.22 * Math.max(0, -s)), 0, 0);
    targets.RightLeg = qEulerYXZ(Math.max(0, 0.15 + 0.95 * Math.max(0, -c) + 0.22 * Math.max(0, s)), 0, 0);
    targets.LeftFoot = qEulerYXZ(-0.22 * c, 0, 0);
    targets.RightFoot = qEulerYXZ(0.22 * c, 0, 0);
    setArmPose(profile, targets, "L", 1.15, 0.68 * s - 0.1, 1.18 + 0.2 * Math.max(0, -s));
    setArmPose(profile, targets, "R", 1.15, -0.68 * s - 0.1, 1.18 + 0.2 * Math.max(0, s));
    targets.Hips = qEulerYXZ(0.06, -0.14 * s, -0.04 * s);
    targets.Spine = qEulerYXZ(0.09, 0.07 * s, 0.025 * s);
    targets.Spine1 = qEulerYXZ(0.07, 0.07 * s, 0);
    targets.Spine2 = qEulerYXZ(0.03, 0.05 * s, 0);
    targets.Neck = qEulerYXZ(-0.08, -0.05 * s, 0);
    targets.Head = qEulerYXZ(-0.08, -0.05 * s, 0);
    rootYOffset = modelH * 0.048 * (0.5 + 0.5 * Math.cos(2 * p));
  } else if (mode === "wave") {
    const w = Math.sin(t * 5.8);
    const wLag = Math.sin(t * 5.8 - 0.55);
    setArmPose(profile, targets, "L", 1.24, 0.04, 0.18);
    setArmPose(profile, targets, "R", -0.22 - 0.05 * Math.sin(t * 5.8 - 0.25), -1.36, 1.48 + 0.44 * w, 0.22, 0.24 * wLag);
    targets.Hips = qEulerYXZ(0, 0, -0.02);
    targets.Spine = qEulerYXZ(0.01, -0.05, 0.03 + 0.018 * w);
    targets.Spine1 = qEulerYXZ(0, -0.04, 0.02 + 0.014 * w);
    targets.Head = qEulerYXZ(0.03 * Math.sin(t * 2.2), 0.05, -0.045 * wLag);
    targets.LeftUpLeg = qEulerYXZ(0, 0, -0.025);
    targets.RightUpLeg = qEulerYXZ(0, 0, 0.025);
  } else if (mode === "jump") {
    const u = (t * 0.85) % 1.0;
    let thighX = 0;
    let kneeX = 0.05;
    let footX = 0;
    let spineX = 0;
    let armDrop = 1.2;
    let armSwingX = 0;
    let elbowBend = 0.22;
    if (u < 0.24) {
      const k = Math.sin((u / 0.24) * Math.PI * 0.5);
      thighX = -0.35 * k;
      kneeX = 0.62 * k;
      footX = -0.18 * k;
      spineX = 0.16 * k;
      armDrop = 1.15;
      armSwingX = 0.55 * k;
      elbowBend = 0.45 * k;
      rootYOffset = -modelH * 0.04 * k;
    } else if (u < 0.74) {
      const a = (u - 0.24) / 0.5;
      const h = 4 * a * (1 - a);
      thighX = -0.32 * h;
      kneeX = 0.52 * h;
      footX = 0.25 * h;
      spineX = -0.08 * h;
      armDrop = 1.15 - 1.35 * h;
      armSwingX = -0.32 * h;
      elbowBend = 0.35 + 0.3 * h;
      rootYOffset = modelH * 0.16 * h;
    } else {
      const k = Math.sin(((1.0 - u) / 0.26) * Math.PI * 0.5);
      thighX = -0.24 * k;
      kneeX = 0.45 * k;
      footX = -0.14 * k;
      spineX = 0.1 * k;
      armDrop = 1.15;
      armSwingX = 0.25 * k;
      elbowBend = 0.3;
      rootYOffset = -modelH * 0.025 * k;
    }
    targets.LeftUpLeg = qEulerYXZ(thighX, 0, -0.02);
    targets.RightUpLeg = qEulerYXZ(thighX, 0, 0.02);
    targets.LeftLeg = qEulerYXZ(Math.max(0, kneeX), 0, 0);
    targets.RightLeg = qEulerYXZ(Math.max(0, kneeX), 0, 0);
    targets.LeftFoot = qEulerYXZ(footX, 0, 0);
    targets.RightFoot = qEulerYXZ(footX, 0, 0);
    setArmPose(profile, targets, "L", armDrop, armSwingX, elbowBend);
    setArmPose(profile, targets, "R", armDrop, armSwingX, elbowBend);
    targets.Spine = qEulerYXZ(spineX * 0.6, 0, 0);
    targets.Spine1 = qEulerYXZ(spineX * 0.4, 0, 0);
  }

  return { targets, rootYOffset };
}

function applyRigFrame(profile, baseRootY, loadedRoot, mode, t, modelH, blendAlpha) {
  const { targets, rootYOffset } = evaluateRigMotion(profile, mode, t, modelH);
  const qIdentity = new THREE.Quaternion();
  const targetLocal = new THREE.Quaternion();
  for (const name of Object.keys(profile.boneRest)) {
    const info = profile.boneRest[name];
    const qDelta = mode === "rest" ? qIdentity : (targets[name] || qIdentity);
    computeTargetLocalQ(info, qDelta, targetLocal);
    if (blendAlpha >= 1) {
      info.bone.quaternion.copy(targetLocal);
    } else {
      info.bone.quaternion.slerp(targetLocal, blendAlpha);
    }
  }
  const targetY = baseRootY + rootYOffset;
  if (blendAlpha >= 1) {
    loadedRoot.position.y = targetY;
  } else {
    loadedRoot.position.y += (targetY - loadedRoot.position.y) * blendAlpha;
  }
}

function buildGenericRigProfile(root) {
  root.updateMatrixWorld(true);
  const bones = [];
  const boneToEntry = new Map();
  const childrenMap = new Map();
  const posTmp = new THREE.Vector3();

  root.traverse((obj) => {
    if (!obj.isBone || !obj.parent) return;
    const parentWorldQ = new THREE.Quaternion();
    obj.parent.getWorldQuaternion(parentWorldQ);
    obj.getWorldPosition(posTmp);
    const entry = {
      idx: bones.length,
      bone: obj,
      name: obj.name || `Bone_${bones.length}`,
      restLocalQ: obj.quaternion.clone(),
      parentRestWorldQ: parentWorldQ,
      parentRestWorldQInv: parentWorldQ.clone().invert(),
      worldPos: posTmp.clone(),
      parentEntry: null,
      children: [],
      isRoot: !obj.parent.isBone,
      depth: 0,
      subtreeSize: 1,
      minSubtreeY: posTmp.y,
      chainSeg: 0,
      role: "chain",
      side: 1,
      phaseOffset: 0,
      liftAxis: null,
    };
    bones.push(entry);
    boneToEntry.set(obj, entry);
    childrenMap.set(obj, []);
  });

  if (bones.length < 2) {
    return {
      hasRig: false,
      rigType: "none",
      bones: [],
      fwdAxis: new THREE.Vector3(0, 0, 1),
      rightAxis: new THREE.Vector3(1, 0, 0),
      legCount: 0,
      wingCount: 0,
    };
  }

  for (const e of bones) {
    if (boneToEntry.has(e.bone.parent)) {
      const p = boneToEntry.get(e.bone.parent);
      e.parentEntry = p;
      p.children.push(e);
      childrenMap.get(e.bone.parent).push(e);
    }
  }

  // BFS depth from armature root(s)
  const roots = bones.filter((e) => e.isRoot);
  const bfsOrder = [];
  const bfs = roots.length ? [...roots] : [bones[0]];
  if (!roots.length) bones[0].isRoot = true;
  const seen = new Set(bfs);
  while (bfs.length) {
    const cur = bfs.shift();
    bfsOrder.push(cur);
    for (const ch of cur.children) {
      if (!seen.has(ch)) {
        ch.depth = cur.depth + 1;
        seen.add(ch);
        bfs.push(ch);
      }
    }
  }

  // Bottom-up subtree size and min Y
  for (let i = bfsOrder.length - 1; i >= 0; i--) {
    const e = bfsOrder[i];
    let sz = 1;
    let mY = e.worldPos.y;
    for (const ch of e.children) {
      sz += ch.subtreeSize;
      if (ch.minSubtreeY < mY) mY = ch.minSubtreeY;
    }
    e.subtreeSize = sz;
    e.minSubtreeY = mY;
  }

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const e of bones) {
    minX = Math.min(minX, e.worldPos.x);
    maxX = Math.max(maxX, e.worldPos.x);
    minY = Math.min(minY, e.worldPos.y);
    maxY = Math.max(maxY, e.worldPos.y);
    minZ = Math.min(minZ, e.worldPos.z);
    maxZ = Math.max(maxZ, e.worldPos.z);
  }
  const spanX = Math.max(0.1, maxX - minX);
  const spanY = Math.max(0.1, maxY - minY);
  const spanZ = Math.max(0.1, maxZ - minZ);
  const spanXZ = Math.max(spanX, spanZ, 0.1);
  const rootPos = (roots[0] || bones[0]).worldPos;

  // Identify trunk hub bones (root + multi-branch spine/chest hubs)
  const trunkSet = new Set();
  for (const e of bfsOrder) {
    if (e.isRoot) {
      trunkSet.add(e);
      continue;
    }
    if (!trunkSet.has(e.parentEntry)) continue;
    const multiChildren = e.children.filter((ch) => ch.subtreeSize >= 2).length;
    const yNorm = (e.worldPos.y - minY) / spanY;
    const minSubYNorm = (e.minSubtreeY - minY) / spanY;
    if (e.subtreeSize >= 3 && (multiChildren >= 2 || (e.depth <= 1 && e.subtreeSize >= 4 && minSubYNorm >= 0.25 && yNorm >= 0.30))) {
      trunkSet.add(e);
    }
  }

  // Estimate creature's forward & lateral principal axes in XZ
  let fx = 0;
  let fz = 1;
  let bestUpper = null;
  let bestUpperScore = -Infinity;
  for (const e of bones) {
    if (e.isRoot) continue;
    const yNorm = (e.worldPos.y - minY) / spanY;
    if (yNorm > 0.55) {
      const distXZ = Math.hypot(e.worldPos.x - rootPos.x, e.worldPos.z - rootPos.z);
      const score = yNorm * 2.0 + (distXZ / spanXZ) * (trunkSet.has(e) ? 1.5 : 0.6);
      if (score > bestUpperScore) {
        bestUpperScore = score;
        bestUpper = e;
      }
    }
  }
  const upperTrunk = Array.from(trunkSet).filter((e) => !e.isRoot).sort((a, b) => b.worldPos.y - a.worldPos.y)[0] || bestUpper;
  let trunkHorizLen = 0;
  if (upperTrunk) {
    const dx = upperTrunk.worldPos.x - rootPos.x;
    const dz = upperTrunk.worldPos.z - rootPos.z;
    trunkHorizLen = Math.hypot(dx, dz);
    if (trunkHorizLen > 0.12 * spanXZ) {
      fx = dx / trunkHorizLen;
      fz = dz / trunkHorizLen;
    }
  }
  if (trunkHorizLen <= 0.12 * spanXZ) {
    let meanX = 0, meanZ = 0;
    for (const e of bones) { meanX += e.worldPos.x; meanZ += e.worldPos.z; }
    meanX /= bones.length;
    meanZ /= bones.length;
    let cxx = 0, cxz = 0, czz = 0;
    for (const e of bones) {
      const dx = e.worldPos.x - meanX;
      const dz = e.worldPos.z - meanZ;
      cxx += dx * dx;
      cxz += dx * dz;
      czz += dz * dz;
    }
    const trace = cxx + czz;
    const disc = Math.sqrt(Math.max(0, (cxx - czz) * (cxx - czz) + 4 * cxz * cxz));
    const lambda1 = 0.5 * (trace + disc);
    let vx = cxz;
    let vz = lambda1 - cxx;
    if (Math.hypot(vx, vz) < 1e-6) {
      vx = lambda1 - czz;
      vz = cxz;
    }
    const vlen = Math.hypot(vx, vz);
    if (vlen > 1e-6) {
      fx = vx / vlen;
      fz = vz / vlen;
      if (fz < 0) { fx = -fx; fz = -fz; }
    }
  }

  const fwdAxis = new THREE.Vector3(fx, 0, fz).normalize();
  const rightAxis = new THREE.Vector3(fwdAxis.z, 0, -fwdAxis.x).normalize();

  // Classify whole kinematic chains branched from trunk
  const legChains = [];
  let wingCount = 0;

  for (const tBone of trunkSet) {
    for (const child of tBone.children) {
      if (trunkSet.has(child)) continue;

      const chain = [];
      const q = [[child, 0]];
      while (q.length) {
        const [cur, seg] = q.shift();
        cur.chainSeg = seg;
        chain.push(cur);
        for (const sub of cur.children) {
          q.push([sub, seg + 1]);
        }
      }

      const startPos = child.worldPos;
      const startYNorm = (startPos.y - minY) / spanY;
      let minChainY = Infinity;
      let maxChainY = -Infinity;
      let tipEntry = child;
      let maxDistSq = -1;
      for (const b of chain) {
        if (b.worldPos.y < minChainY) minChainY = b.worldPos.y;
        if (b.worldPos.y > maxChainY) maxChainY = b.worldPos.y;
        const dSq = b.worldPos.distanceToSquared(startPos);
        if (dSq >= maxDistSq) {
          maxDistSq = dSq;
          tipEntry = b;
        }
      }
      const minYNorm = (minChainY - minY) / spanY;
      const maxYNorm = (maxChainY - minY) / spanY;
      const tipYNorm = (tipEntry.worldPos.y - minY) / spanY;

      const latStart = (startPos.x - rootPos.x) * rightAxis.x + (startPos.z - rootPos.z) * rightAxis.z;
      const latTip = (tipEntry.worldPos.x - rootPos.x) * rightAxis.x + (tipEntry.worldPos.z - rootPos.z) * rightAxis.z;
      const side = (Math.abs(latTip) > 0.04 * spanXZ ? latTip : latStart) >= 0 ? 1 : -1;
      const fwdOff = (startPos.x - rootPos.x) * fwdAxis.x + (startPos.z - rootPos.z) * fwdAxis.z;
      const fwdDelta = (tipEntry.worldPos.x - startPos.x) * fwdAxis.x + (tipEntry.worldPos.z - startPos.z) * fwdAxis.z;
      const horizOut = Math.hypot(tipEntry.worldPos.x - startPos.x, tipEntry.worldPos.z - startPos.z);

      let role = "chain";
      let liftAxis = null;
      const isArchedSplayedLeg = (
        horizOut > 0.22 * spanXZ &&
        tipYNorm < 0.45 &&
        (maxYNorm - Math.max(startYNorm, tipYNorm)) > 0.16 &&
        (maxYNorm - tipYNorm) > 0.22
      );
      const isDropLeg = minYNorm < 0.25 && (startYNorm - minYNorm > 0.12 || tipYNorm < 0.22);
      if (isArchedSplayedLeg || isDropLeg) {
        const isSplayed = isArchedSplayedLeg || (maxYNorm > startYNorm + 0.12 && horizOut > 0.26 * spanXZ);
        role = isSplayed ? "splayed_leg" : "leg";
        if (isSplayed) {
          const rx = tipEntry.worldPos.x - rootPos.x;
          const rz = tipEntry.worldPos.z - rootPos.z;
          const radLen = Math.hypot(rx, rz);
          const radAxis = radLen > 1e-4 ? new THREE.Vector3(rx / radLen, 0, rz / radLen) : rightAxis.clone().multiplyScalar(side);
          liftAxis = new THREE.Vector3().crossVectors(_vAxisY, radAxis).normalize();
          if (liftAxis.lengthSq() < 1e-6) liftAxis = rightAxis.clone();
        }
        legChains.push({ chain, side, fwdOff });
      } else if (maxYNorm > 0.52 && Math.abs(latTip) > 0.17 * spanXZ) {
        role = "wing";
        wingCount++;
      } else if (maxYNorm > 0.60 && (fwdDelta >= -0.10 * spanXZ || tipYNorm > 0.72)) {
        role = "neck";
      } else if (fwdDelta < -0.08 * spanXZ) {
        role = "tail";
      }

      for (const b of chain) {
        b.role = role;
        b.side = side;
        b.liftAxis = liftAxis;
      }
    }
  }

  for (const tBone of trunkSet) {
    tBone.role = tBone.isRoot ? "root" : "spine";
  }

  // Alternating diagonal quadruped / multi-leg gait phase assignment
  const leftLegs = legChains.filter((c) => c.side < 0).sort((a, b) => b.fwdOff - a.fwdOff);
  const rightLegs = legChains.filter((c) => c.side >= 0).sort((a, b) => b.fwdOff - a.fwdOff);
  leftLegs.forEach((lc, i) => {
    const ph = (i % 2 === 0) ? 0 : Math.PI;
    for (const b of lc.chain) b.phaseOffset = ph;
  });
  rightLegs.forEach((rc, i) => {
    const ph = (i % 2 === 0) ? Math.PI : 0;
    for (const b of rc.chain) b.phaseOffset = ph;
  });

  return {
    hasRig: true,
    rigType: "generic",
    bones,
    fwdAxis,
    rightAxis,
    legCount: legChains.length,
    wingCount,
  };
}

function evaluateGenericBoneDelta(profile, entry, mode, t, modelH) {
  if (mode === "rest") return { q: new THREE.Quaternion(), rootYOffset: 0 };
  const { fwdAxis, rightAxis, legCount, wingCount } = profile;
  const seg = entry.chainSeg || 0;
  const att = 1 / (1 + 0.16 * seg);
  let rootYOffset = 0;

  if (mode === "g_idle") {
    const br = Math.sin(t * 1.8 - seg * 0.4);
    const look = Math.sin(t * 0.75);
    if (entry.role === "root") {
      rootYOffset = modelH * 0.008 * (0.5 + 0.5 * Math.sin(t * 1.8));
      const qR = qAxisAngle(rightAxis, 0.015 * Math.sin(t * 1.8));
      const qY = qAxisAngle(_vAxisY, 0.02 * look);
      return { q: qY.multiply(qR), rootYOffset };
    }
    if (entry.role === "spine") {
      return { q: qAxisAngle(rightAxis, 0.025 * br), rootYOffset };
    }
    if (entry.role === "neck") {
      const qY = qAxisAngle(_vAxisY, 0.09 * look * att);
      const qP = qAxisAngle(rightAxis, 0.03 * Math.sin(t * 1.8 - seg * 0.35));
      return { q: qY.multiply(qP), rootYOffset };
    }
    if (entry.role === "wing") {
      return { q: qAxisAngle(fwdAxis, entry.side * 0.08 * br * att), rootYOffset };
    }
    if (entry.role === "tail") {
      return { q: qAxisAngle(_vAxisY, 0.14 * Math.sin(t * 1.2 - seg * 0.6) * (0.8 + 0.2 * seg)), rootYOffset };
    }
    if (entry.role === "leg" || entry.role === "splayed_leg") {
      return { q: qAxisAngle(entry.liftAxis || rightAxis, 0.025 * Math.sin(t * 1.8) * att), rootYOffset };
    }
    return { q: qAxisAngle(_vAxisY, 0.05 * Math.sin(t * 1.3 - seg * 0.5)), rootYOffset };
  }

  if (mode === "g_walk") {
    const p = t * 0.95 * Math.PI * 2;
    const s = Math.sin(p);
    if (entry.role === "root") {
      rootYOffset = modelH * (legCount > 0 ? 0.018 : 0.025) * (0.5 + 0.5 * Math.cos(2 * p));
      const qY = qAxisAngle(_vAxisY, 0.07 * s);
      const qRoll = qAxisAngle(fwdAxis, 0.035 * s);
      return { q: qY.multiply(qRoll), rootYOffset };
    }
    if (entry.role === "leg") {
      const lp = p + entry.phaseOffset;
      const ls = Math.sin(lp);
      const lc = Math.cos(lp);
      if (seg === 0) return { q: qAxisAngle(rightAxis, -0.46 * ls), rootYOffset };
      if (seg === 1) return { q: qAxisAngle(rightAxis, 0.62 * Math.max(0, lc) + 0.12 * Math.max(0, ls)), rootYOffset };
      return { q: qAxisAngle(rightAxis, -0.26 * lc - 0.10 * ls), rootYOffset };
    }
    if (entry.role === "splayed_leg") {
      const lp = p + entry.phaseOffset;
      const ls = Math.sin(lp);
      const lc = Math.cos(lp);
      const axis = entry.liftAxis || rightAxis;
      if (seg === 0) {
        const qY = qAxisAngle(_vAxisY, entry.side * 0.30 * ls);
        const qLift = qAxisAngle(axis, 0.32 * Math.max(0, lc));
        return { q: qY.multiply(qLift), rootYOffset };
      }
      return { q: qAxisAngle(axis, -0.36 * Math.max(0, lc)), rootYOffset };
    }
    if (entry.role === "wing") {
      const flap = Math.sin(p - seg * 0.55);
      return { q: qAxisAngle(fwdAxis, entry.side * (0.10 + 0.18 * flap)), rootYOffset };
    }
    if (entry.role === "spine") {
      const qY = qAxisAngle(_vAxisY, 0.08 * Math.sin(p - entry.depth * 0.5));
      const qP = qAxisAngle(rightAxis, 0.04 * Math.cos(2 * p));
      return { q: qY.multiply(qP), rootYOffset };
    }
    if (entry.role === "neck") {
      const qY = qAxisAngle(_vAxisY, -0.06 * s);
      const qP = qAxisAngle(rightAxis, 0.09 * Math.cos(2 * p - 0.5) * att);
      return { q: qY.multiply(qP), rootYOffset };
    }
    if (entry.role === "tail") {
      const amp = Math.min(1.4, 0.75 + 0.25 * seg);
      const qY = qAxisAngle(_vAxisY, 0.24 * amp * Math.sin(p - seg * 0.75));
      const qP = qAxisAngle(rightAxis, 0.07 * Math.cos(p - seg * 0.6));
      return { q: qY.multiply(qP), rootYOffset };
    }
    // Legless dragon / serpent / generic secondary chains
    const qY = qAxisAngle(_vAxisY, (legCount === 0 ? 0.30 : 0.14) * Math.sin(p - entry.depth * 0.65));
    const qP = qAxisAngle(rightAxis, (legCount === 0 ? 0.15 : 0.05) * Math.cos(p - entry.depth * 0.55));
    return { q: qY.multiply(qP), rootYOffset };
  }

  if (mode === "g_action") {
    const flap = Math.sin(t * 4.0 - seg * 0.55);
    const flapCos = Math.cos(t * 4.0 - seg * 0.55);
    const rear = 0.5 + 0.5 * Math.sin(t * 2.2);
    if (entry.role === "root") {
      rootYOffset = modelH * (wingCount > 0 ? 0.045 : 0.025) * (0.5 + 0.5 * Math.sin(t * 4.0));
      return { q: qAxisAngle(rightAxis, -0.08 * Math.sin(t * 2.2)), rootYOffset };
    }
    if (entry.role === "wing") {
      const qFlap = qAxisAngle(fwdAxis, entry.side * (0.52 * flap + 0.12));
      const qSweep = qAxisAngle(_vAxisY, -entry.side * 0.14 * flapCos);
      return { q: qSweep.multiply(qFlap), rootYOffset };
    }
    if (entry.role === "neck") {
      const qUp = qAxisAngle(rightAxis, -0.22 * rear * att);
      const qRoar = qAxisAngle(_vAxisY, 0.14 * Math.sin(t * 6.5) * att);
      return { q: qRoar.multiply(qUp), rootYOffset };
    }
    if (entry.role === "tail") {
      return { q: qAxisAngle(_vAxisY, 0.32 * Math.sin(t * 3.8 - seg * 0.7)), rootYOffset };
    }
    if (entry.role === "leg" || entry.role === "splayed_leg") {
      return { q: qAxisAngle(entry.liftAxis || rightAxis, 0.14 * Math.sin(t * 2.2) * att), rootYOffset };
    }
    return { q: qAxisAngle(_vAxisY, 0.16 * Math.sin(t * 3.5 - seg * 0.6)), rootYOffset };
  }

  return { q: new THREE.Quaternion(), rootYOffset: 0 };
}

function applyGenericRigFrame(profile, baseRootY, loadedRoot, mode, t, modelH, blendAlpha) {
  const targetLocal = new THREE.Quaternion();
  let rootYOffset = 0;
  for (const entry of profile.bones) {
    const ev = evaluateGenericBoneDelta(profile, entry, mode, t, modelH);
    if (entry.isRoot) rootYOffset = ev.rootYOffset;
    computeTargetLocalQ(entry, ev.q, targetLocal);
    if (blendAlpha >= 1) {
      entry.bone.quaternion.copy(targetLocal);
    } else {
      entry.bone.quaternion.slerp(targetLocal, blendAlpha);
    }
  }
  const targetY = baseRootY + rootYOffset;
  if (blendAlpha >= 1) {
    loadedRoot.position.y = targetY;
  } else {
    loadedRoot.position.y += (targetY - loadedRoot.position.y) * blendAlpha;
  }
}

window.unmountGlbViewer = function () {
  if (!activeState) return;
  cancelAnimationFrame(activeState.raf);
  if (activeState.ro) activeState.ro.disconnect();
  if (activeState.mixer) activeState.mixer.stopAllAction();
  if (activeState.skelHelper) {
    activeState.scene.remove(activeState.skelHelper);
    if (activeState.skelHelper.geometry) activeState.skelHelper.geometry.dispose();
    const smats = Array.isArray(activeState.skelHelper.material)
      ? activeState.skelHelper.material
      : [activeState.skelHelper.material];
    for (const sm of smats) {
      if (sm && sm.dispose) sm.dispose();
    }
  }
  activeState.controls.dispose();
  activeState.scene.traverse((obj) => {
    if (obj.isMesh) {
      if (obj.geometry) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        for (const val of Object.values(m)) {
          if (val && val.isTexture) val.dispose();
        }
        m.dispose();
      }
    }
  });
  activeState.clayMat.dispose();
  activeState.wireMat.dispose();
  activeState.renderer.dispose();
  activeState = null;
};

window.mountGlbViewer = function (hostEl, glbUrl) {
  window.unmountGlbViewer();
  hostEl.innerHTML = "";

  const ctrlBar = document.createElement("div");
  ctrlBar.className = "viewer-controls";
  ctrlBar.innerHTML = `
    <button type="button" class="chip active" data-vsh="color">カラー3D</button>
    <button type="button" class="chip" data-vsh="clay">クレイ形状</button>
    <button type="button" class="chip" data-vsh="wire">ワイヤー</button>
    <button type="button" class="chip" data-vcam="front">正面</button>
    <button type="button" class="chip" data-vcam="side">側面</button>
    <button type="button" class="chip" data-vcam="back">背面</button>
    <button type="button" class="chip" data-vcam="face">顔アップ</button>
    <button type="button" class="chip" data-vrot="1">自動回転</button>
  `;

  const motionBar = document.createElement("div");
  motionBar.className = "viewer-motion-bar";
  motionBar.innerHTML = `<span class="viewer-motion-label">モーション判定中...</span>`;

  const box = document.createElement("div");
  box.className = "viewer-box";
  const status = document.createElement("div");
  status.className = "viewer-status";
  status.textContent = "3Dモデル読込中...";
  box.appendChild(status);
  hostEl.appendChild(ctrlBar);
  hostEl.appendChild(motionBar);
  hostEl.appendChild(box);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(box.clientWidth || 400, box.clientHeight || 440);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  box.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2b2e38);

  const camera = new THREE.PerspectiveCamera(36, (box.clientWidth || 400) / (box.clientHeight || 440), 0.02, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x3b3e4c, 1.1);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(1.8, 3.2, 2.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdbe8ff, 0.85);
  fill.position.set(-2.2, 1.6, 1.5);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xfff0dd, 1.1);
  rim.position.set(0.0, 2.4, -2.8);
  scene.add(rim);

  const grid = new THREE.GridHelper(3.0, 12, 0x454a5c, 0x343846);
  scene.add(grid);

  const clayMat = new THREE.MeshStandardMaterial({ color: 0xa0a2a8, roughness: 0.62, metalness: 0.04 });
  const wireMat = new THREE.MeshStandardMaterial({ color: 0x7aa8ff, roughness: 0.5, wireframe: true });
  const origMats = new Map();
  let modelH = 1.65;
  let autoRot = false;
  let loadedRoot = null;
  let rigProfile = null;
  let rigType = "none";
  let baseRootPos = new THREE.Vector3();
  let baseRootScale = new THREE.Vector3(1, 1, 1);
  let clipActions = [];
  let activeMotion = "rest";
  let motionSpeed = lastMotionSpeed;
  let showSkel = lastShowSkel;
  let motionTime = 0;
  let prevTime = performance.now();

  function setCam(preset) {
    const dist = Math.max(0.9, modelH * 1.65);
    if (preset === "front") {
      camera.position.set(0, modelH * 0.52, dist);
      controls.target.set(0, modelH * 0.50, 0);
    } else if (preset === "side") {
      camera.position.set(dist, modelH * 0.52, 0);
      controls.target.set(0, modelH * 0.50, 0);
    } else if (preset === "back") {
      camera.position.set(0, modelH * 0.52, -dist);
      controls.target.set(0, modelH * 0.50, 0);
    } else if (preset === "face") {
      camera.position.set(0, modelH * 0.89, Math.max(0.32, modelH * 0.36));
      controls.target.set(0, modelH * 0.88, 0);
    }
    controls.update();
  }

  function selectMotion(mode) {
    activeMotion = mode;
    motionTime = 0;
    if (!mode.startsWith("clip:")) {
      if (rigType === "mixamo") lastRigMotion = mode;
      else if (rigType === "generic") lastGenericMotion = mode;
      else lastSimpleMotion = mode;
    }
    if (state.mixer) {
      state.mixer.stopAllAction();
      if (mode.startsWith("clip:")) {
        const idx = Number(mode.slice(5));
        const act = clipActions[idx];
        if (act) act.reset().play();
      }
    }
      if (!(mode in MOTION_SPEED_M)) {
        grid.position.x = 0;
        grid.position.z = 0;
      }
    motionBar.querySelectorAll("[data-vmot]").forEach((b) => {
      b.classList.toggle("active", b.dataset.vmot === mode);
    });
  }

  function renderMotionBar(clips) {
    const buttons = [];
    if (rigType === "mixamo") {
      buttons.push(
        ["rest", "静止"],
        ["idle", "待機"],
        ["walk", "歩行"],
        ["run", "走行"],
        ["wave", "手を振る"],
        ["jump", "ジャンプ"]
      );
    } else if (rigType === "generic") {
      buttons.push(
        ["rest", "静止"],
        ["g_idle", "待機・呼吸"],
        ["g_walk", "歩行・うねり"],
        ["g_action", "羽ばたき・威嚇"]
      );
    } else {
      buttons.push(
        ["rest", "静止"],
        ["float", "呼吸・浮遊"],
        ["bounce", "歩行風バウンス"]
      );
    }
    clips.forEach((clip, idx) => {
      buttons.push([`clip:${idx}`, clip.name ? `Clip: ${clip.name}` : `再生#${idx + 1}`]);
    });

    const labelText =
      rigType === "mixamo"
        ? "モーション (人型22ボーン):"
        : rigType === "generic"
        ? `モーション (汎用${rigProfile.bones.length}ボーン):`
        : "簡易モーション (リグなし):";
    const skelBtnHtml =
      rigType !== "none"
        ? `<button type="button" class="chip${showSkel ? " active" : ""}" data-vskel="1">骨格表示</button>`
        : "";

    motionBar.innerHTML =
      `<span class="viewer-motion-label">${labelText}</span>` +
      buttons
        .map(([id, label]) => `<button type="button" class="chip" data-vmot="${id}">${label}</button>`)
        .join("") +
      `<span class="viewer-motion-sep"></span>` +
      skelBtnHtml +
      `<button type="button" class="chip" data-vspd="1">速度 ${motionSpeed}x</button>`;

    motionBar.querySelectorAll("[data-vmot]").forEach((btn) => {
      btn.addEventListener("click", () => selectMotion(btn.dataset.vmot));
    });
    const skelBtn = motionBar.querySelector("[data-vskel]");
    if (skelBtn) {
      skelBtn.addEventListener("click", () => {
        showSkel = !showSkel;
        lastShowSkel = showSkel;
        skelBtn.classList.toggle("active", showSkel);
        if (state.skelHelper) state.skelHelper.visible = showSkel;
      });
    }
    const spdBtn = motionBar.querySelector("[data-vspd]");
    if (spdBtn) {
      spdBtn.addEventListener("click", () => {
        const idx = SPEED_STEPS.indexOf(motionSpeed);
        motionSpeed = SPEED_STEPS[(idx + 1) % SPEED_STEPS.length];
        lastMotionSpeed = motionSpeed;
        spdBtn.textContent = `速度 ${motionSpeed}x`;
      });
    }

    if (rigType === "mixamo") {
      selectMotion(lastRigMotion);
    } else if (rigType === "generic") {
      selectMotion(lastGenericMotion);
    } else if (clips.length > 0) {
      selectMotion("clip:0");
    } else {
      selectMotion(lastSimpleMotion);
    }
  }

  ctrlBar.querySelectorAll("[data-vsh]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctrlBar.querySelectorAll("[data-vsh]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const sh = btn.dataset.vsh;
      if (!loadedRoot) return;
      loadedRoot.traverse((obj) => {
        if (!obj.isMesh) return;
        if (sh === "clay") obj.material = clayMat;
        else if (sh === "wire") obj.material = wireMat;
        else obj.material = origMats.get(obj) || obj.material;
      });
    });
  });

  ctrlBar.querySelectorAll("[data-vcam]").forEach((btn) => {
    btn.addEventListener("click", () => setCam(btn.dataset.vcam));
  });
  const rotBtn = ctrlBar.querySelector("[data-vrot]");
  rotBtn.addEventListener("click", () => {
    autoRot = !autoRot;
    rotBtn.classList.toggle("active", autoRot);
    controls.autoRotate = autoRot;
    controls.autoRotateSpeed = 2.4;
  });

  const ro = new ResizeObserver(() => {
    const w = box.clientWidth || 400;
    const h = box.clientHeight || 440;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  ro.observe(box);

  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(new URL("./vendor/draco/", import.meta.url).href);
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);

  const state = { renderer, scene, camera, controls, clayMat, wireMat, ro, mixer: null, skelHelper: null, raf: 0 };
  activeState = state;

  loader.load(
    glbUrl,
    (gltf) => {
      if (activeState !== state) return;
      loadedRoot = gltf.scene;
      loadedRoot.traverse((obj) => {
        if (obj.isMesh) {
          if (obj.name && obj.name.startsWith("Icosphere")) {
            obj.visible = false;
          } else {
            origMats.set(obj, obj.material);
            if (obj.geometry && !obj.geometry.attributes.normal) {
              obj.geometry.computeVertexNormals();
            }
          }
        }
      });
      const b = new THREE.Box3().setFromObject(loadedRoot);
      const sz = new THREE.Vector3();
      const ctr = new THREE.Vector3();
      b.getSize(sz);
      b.getCenter(ctr);
      loadedRoot.position.set(-ctr.x, -b.min.y, -ctr.z);
      baseRootPos.copy(loadedRoot.position);
      baseRootScale.copy(loadedRoot.scale);
      modelH = Math.max(0.2, sz.y, sz.x * 0.7);
      scene.add(loadedRoot);

      const mixProfile = buildRigProfile(loadedRoot);
      if (mixProfile.hasRig) {
        rigProfile = mixProfile;
        rigType = "mixamo";
      } else {
        const genProfile = buildGenericRigProfile(loadedRoot);
        if (genProfile.hasRig) {
          rigProfile = genProfile;
          rigType = "generic";
        } else {
          rigProfile = genProfile;
          rigType = "none";
        }
      }
      if (rigType !== "none") {
        const skelHelper = new THREE.SkeletonHelper(loadedRoot);
        skelHelper.visible = showSkel;
        const smats = Array.isArray(skelHelper.material) ? skelHelper.material : [skelHelper.material];
        for (const sm of smats) {
          if (!sm) continue;
          sm.depthTest = false;
          sm.transparent = true;
          sm.opacity = 0.9;
        }
        skelHelper.renderOrder = 999;
        scene.add(skelHelper);
        state.skelHelper = skelHelper;
      }
      const clips = Array.isArray(gltf.animations) ? gltf.animations : [];
      if (clips.length > 0) {
        state.mixer = new THREE.AnimationMixer(loadedRoot);
        clipActions = clips.map((clip) => state.mixer.clipAction(clip));
      }
      renderMotionBar(clips);

      setCam("front");
      status.style.display = "none";
    },
    undefined,
    (err) => {
      status.textContent = "3D読込エラー: " + (err && err.message ? err.message : "unknown");
      motionBar.innerHTML = `<span class="viewer-motion-label">読込エラー</span>`;
    }
  );

  function applySimpleMotion(dt) {
    const blend = Math.min(1, dt * 10);
    let targetY = baseRootPos.y;
    let targetRotX = 0;
    let targetRotY = 0;
    let targetRotZ = 0;
    let targetScaleY = baseRootScale.y;

    if (activeMotion === "float") {
      targetY = baseRootPos.y + modelH * 0.03 * (0.5 + 0.5 * Math.sin(motionTime * 2.2));
      targetRotZ = 0.035 * Math.sin(motionTime * 1.4);
      targetRotY = 0.06 * Math.sin(motionTime * 0.9);
      targetScaleY = baseRootScale.y * (1 + 0.018 * Math.sin(motionTime * 2.2));
    } else if (activeMotion === "bounce") {
      const p = motionTime * 0.95 * Math.PI * 2;
      targetY = baseRootPos.y + modelH * 0.055 * Math.abs(Math.sin(p));
      targetRotZ = 0.07 * Math.sin(p);
      targetRotX = 0.04 * Math.abs(Math.cos(p));
    }
    loadedRoot.position.y += (targetY - loadedRoot.position.y) * blend;
    loadedRoot.rotation.x += (targetRotX - loadedRoot.rotation.x) * blend;
    loadedRoot.rotation.y += (targetRotY - loadedRoot.rotation.y) * blend;
    loadedRoot.rotation.z += (targetRotZ - loadedRoot.rotation.z) * blend;
    loadedRoot.scale.y += (targetScaleY - loadedRoot.scale.y) * blend;
  }

  function animate(now) {
    if (activeState !== state) return;
    state.raf = requestAnimationFrame(animate);
    const dt = Math.min(0.05, Math.max(0.001, ((now || performance.now()) - prevTime) / 1000));
    prevTime = now || performance.now();

    if (loadedRoot) {
      const sDt = dt * motionSpeed;
      motionTime += sDt;
      const blend = Math.min(1, dt * 12);

      if (activeMotion.startsWith("clip:") && state.mixer) {
        state.mixer.update(sDt);
      } else if (rigType === "mixamo" && rigProfile) {
        applyRigFrame(rigProfile, baseRootPos.y, loadedRoot, activeMotion, motionTime, modelH, blend);
      } else if (rigType === "generic" && rigProfile) {
        applyGenericRigFrame(rigProfile, baseRootPos.y, loadedRoot, activeMotion, motionTime, modelH, blend);
      } else {
        applySimpleMotion(dt);
      }

      const gSpd = MOTION_SPEED_M[activeMotion] || 0;
      if (gSpd > 0) {
        let dirX = 0;
        let dirZ = 1;
        if (rigType === "generic" && rigProfile && rigProfile.fwdAxis) {
          dirX = rigProfile.fwdAxis.x;
          dirZ = rigProfile.fwdAxis.z;
        }
        const wrapCell = (v) => ((v % GRID_CELL_M) + GRID_CELL_M) % GRID_CELL_M - GRID_CELL_M;
        grid.position.x = wrapCell(grid.position.x - gSpd * dirX * sDt);
        grid.position.z = wrapCell(grid.position.z - gSpd * dirZ * sDt);
      }
    }

    controls.update();
    renderer.render(scene, camera);
  }
  animate(performance.now());
};
