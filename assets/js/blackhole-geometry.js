/* Original black-hole-inspired geometry, not a physical lensing simulation. */
(() => {
  'use strict';

  window.createBlackHoleStudyMesh = function createBlackHoleStudyMesh() {
    const data = [];
    const triangles = [];
    const stride = 12;
    const tau = Math.PI * 2;

    function vertex(x, y, z, nx, ny, nz, u, v, tx, ty, tz, kind) {
      data.push(x, y, z, nx, ny, nz, u, v, tx, ty, tz, kind);
    }

    function patch(rows, columns, sample, reverse = false) {
      const start = data.length / stride;
      for (let i = 0; i <= rows; i++) {
        for (let j = 0; j <= columns; j++) sample(i / rows, j / columns);
      }
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < columns; j++) {
          const a = start + i * (columns + 1) + j;
          const b = a + columns + 1;
          if (reverse) triangles.push(a, a + 1, b, b, a + 1, b + 1);
          else triangles.push(a, b, a + 1, b, b + 1, a + 1);
        }
      }
      return start;
    }

    // The core remains geometrically opaque, including in wire/vertex views.
    patch(20, 40, (u, v) => {
      const polar = Math.PI * u;
      const angle = tau * v;
      const nx = Math.sin(polar) * Math.cos(angle);
      const ny = Math.cos(polar);
      const nz = Math.sin(polar) * Math.sin(angle);
      vertex(nx * 0.57, ny * 0.57, nz * 0.57, nx, ny, nz,
        v, u, nx * 0.57, ny * 0.57, nz * 0.57, 2);
    });

    const diskRows = 6;
    const diskColumns = 96;
    const diskCount = (diskRows + 1) * (diskColumns + 1);
    const diskRadius = new Float32Array(diskCount);
    const diskAngle = new Float32Array(diskCount);
    const diskCos = new Float32Array(diskCount);
    const diskSin = new Float32Array(diskCount);
    let diskIndex = 0;
    const diskStart = patch(diskRows, diskColumns, (u, v) => {
      const radius = 0.76 + 0.32 * u;
      const angle = tau * v;
      diskRadius[diskIndex] = radius;
      diskAngle[diskIndex] = angle;
      diskCos[diskIndex] = Math.cos(angle);
      diskSin[diskIndex] = Math.sin(angle);
      diskIndex++;
      vertex(radius * Math.cos(angle), 0, radius * Math.sin(angle), 0, 1, 0,
        v, u, radius * Math.cos(angle), radius * Math.sin(angle), 0, 3);
    }, true);

    const vertices = new Float32Array(data);
    const indices = new Uint16Array(triangles);

    function update(phase) {
      const time = Number.isFinite(phase) ? phase : 0;
      for (let i = 0; i < diskCount; i++) {
        const radius = diskRadius[i];
        const angle = diskAngle[i];
        const c = diskCos[i], s = diskSin[i];
        const wave = angle * 2 + time * 0.25;
        const radialWave = radius * 3 - time * 0.3;
        const height = 0.008 * Math.sin(wave) * ((radius - 0.76) / 0.32)
          + 0.004 * Math.sin(radialWave);
        const slopeR = 0.008 / 0.32 * Math.sin(wave) + 0.012 * Math.cos(radialWave);
        const slopeA = 0.016 * Math.cos(wave) * ((radius - 0.76) / 0.32) / radius;
        const nx = -slopeR * c + slopeA * s;
        const nz = -slopeR * s - slopeA * c;
        const inverse = 1 / Math.hypot(nx, 1, nz);
        const offset = (diskStart + i) * stride;
        vertices[offset] = radius * c;
        vertices[offset + 1] = height;
        vertices[offset + 2] = radius * s;
        vertices[offset + 3] = nx * inverse;
        vertices[offset + 4] = inverse;
        vertices[offset + 5] = nz * inverse;

        // Differential angular flow and a traveling inward ripple are continuous;
        // neither texture coordinate resets nor wraps produce a visible jump.
        const inkAngle = angle + time * (0.18 + 0.12 / (radius + 0.4));
        const inkRadius = radius + 0.025 * Math.sin(time * 0.6 + radius * 2.5);
        vertices[offset + 8] = inkRadius * Math.cos(inkAngle);
        vertices[offset + 9] = inkRadius * Math.sin(inkAngle);
        vertices[offset + 10] = 0.015 * Math.sin(radius * 2 - time * 0.25);
      }
    }

    update(0);
    return { vertices, indices, update };
  };
})();
