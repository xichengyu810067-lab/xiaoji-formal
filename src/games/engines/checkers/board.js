const AXIAL_DIRECTIONS = Object.freeze([
  Object.freeze({ q: 1, r: 0 }),
  Object.freeze({ q: 0, r: 1 }),
  Object.freeze({ q: -1, r: 1 }),
  Object.freeze({ q: -1, r: 0 }),
  Object.freeze({ q: 0, r: -1 }),
  Object.freeze({ q: 1, r: -1 }),
]);

const CAMP_IDS = Object.freeze(['xp', 'xn', 'yp', 'yn', 'zp', 'zn']);
const CAMP_LABELS = Object.freeze({
  xp: '+X',
  xn: '-X',
  yp: '+Y',
  yn: '-Y',
  zp: '+Z',
  zn: '-Z',
});

const OPPOSITE_CAMP = Object.freeze({
  xp: 'xn',
  xn: 'xp',
  yp: 'yn',
  yn: 'yp',
  zp: 'zn',
  zn: 'zp',
});

const CAMP_ASSIGNMENTS = Object.freeze({
  2: Object.freeze(['xp', 'xn']),
  3: Object.freeze(['xp', 'yp', 'zp']),
  4: Object.freeze(['xp', 'xn', 'zp', 'zn']),
  6: Object.freeze(['xp', 'xn', 'yp', 'yn', 'zp', 'zn']),
});

function pointId(q, r) {
  return `q${q}r${r}`;
}

function toPoint(q, r) {
  return Object.freeze({
    id: pointId(q, r),
    // Axial q/r coordinates are projected into a pointy-top hex layout.
    x: q + (r / 2) + 6,
    y: (r + 8) * (Math.sqrt(3) / 2),
    q,
    r,
  });
}

function cubeToAxial(cube) {
  return { q: cube.x, r: cube.z };
}

function campCubePoints(axis, sign) {
  const result = [];
  for (let depth = 0; depth < 4; depth += 1) {
    const dominant = sign * (5 + depth);
    for (let offset = 0; offset < 4 - depth; offset += 1) {
      const first = sign * (-4 + offset);
      const second = -dominant - first;
      const cube = axis === 'x'
        ? { x: dominant, y: first, z: second }
        : axis === 'y'
          ? { x: first, y: dominant, z: second }
          : { x: first, y: second, z: dominant };
      result.push(cubeToAxial(cube));
    }
  }
  return result;
}

function createBoard() {
  const pointById = new Map();
  const add = (q, r) => {
    const point = toPoint(q, r);
    if (pointById.has(point.id)) throw new Error(`Duplicate board point ${point.id}.`);
    pointById.set(point.id, point);
    return point;
  };

  // The central hexagon has radius 4: 1 + 3r(r + 1) = 61 points.
  for (let q = -4; q <= 4; q += 1) {
    for (let r = -4; r <= 4; r += 1) {
      if (Math.abs(q + r) <= 4) add(q, r);
    }
  }

  const campSpecs = {
    xp: ['x', 1],
    xn: ['x', -1],
    yp: ['y', 1],
    yn: ['y', -1],
    zp: ['z', 1],
    zn: ['z', -1],
  };
  const camps = [];
  for (const campId of CAMP_IDS) {
    const [axis, sign] = campSpecs[campId];
    const pointIds = campCubePoints(axis, sign).map(({ q, r }) => add(q, r).id);
    camps.push(Object.freeze({ id: campId, label: CAMP_LABELS[campId], pointIds: Object.freeze(pointIds) }));
  }

  if (pointById.size !== 121 || camps.some((camp) => camp.pointIds.length !== 10)) {
    throw new Error('Chinese checkers board geometry is invalid.');
  }
  return {
    points: Object.freeze([...pointById.values()]),
    pointById,
    camps: Object.freeze(camps),
  };
}

const BOARD = createBoard();
const POINT_BY_ID = BOARD.pointById;
const CAMP_BY_ID = new Map(BOARD.camps.map((camp) => [camp.id, camp]));

module.exports = {
  AXIAL_DIRECTIONS,
  BOARD_POINTS: BOARD.points,
  CAMP_ASSIGNMENTS,
  CAMP_BY_ID,
  CAMPS: BOARD.camps,
  CAMP_IDS,
  CAMP_LABELS,
  OPPOSITE_CAMP,
  POINT_BY_ID,
  pointId,
};
