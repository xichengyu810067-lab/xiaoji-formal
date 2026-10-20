'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  createTestControlObservation,
  CODE_PATTERN,
  OVERFLOW_CODE,
  MAX_CODES,
  observe,
  snapshot,
  _testReset,
  getGlobalRuntimeController,
} = require('../src/platform/testControlObservation');

// Mock runtime controller
function createMockController(active = false) {
  return Object.freeze({ active });
}

test('testControlObservation - inactive (noop mode)', async (t) => {
  const controller = createMockController(false);
  const obs = createTestControlObservation({ runtimeController: controller });

  await t.test('observe() is no-op when inactive', () => {
    // Should not throw, even after many calls
    for (let i = 0; i < 10000; i++) {
      obs.observe('TEST_CODE');
    }
  });

  await t.test('snapshot() returns empty frozen object when inactive', () => {
    const snap = obs.snapshot();
    assert.deepStrictEqual(snap, {});
    assert.throws(
      () => { snap.anything = 1; },
      (err) => err instanceof TypeError
    );
  });

  await t.test('state does not grow even with many observe calls', () => {
    // Call observe many times
    for (let i = 0; i < 10000; i++) {
      obs.observe(`CODE_${i % 100}`);
    }
    // Snapshot should still be empty
    const snap = obs.snapshot();
    assert.deepStrictEqual(snap, {});
  });
});

test('testControlObservation - active mode', async (t) => {
  const controller = createMockController(true);
  const obs = createTestControlObservation({ runtimeController: controller });

  await t.test('snapshot returns empty object initially', () => {
    const snap = obs.snapshot();
    assert.deepStrictEqual(snap, {});
  });

  await t.test('observe() accumulates valid codes', () => {
    obs.observe('TEST_CODE_A');
    obs.observe('TEST_CODE_B');
    obs.observe('TEST_CODE_A');

    const snap = obs.snapshot();
    assert.deepStrictEqual(snap, {
      TEST_CODE_A: 2,
      TEST_CODE_B: 1,
    });
  });

  await t.test('snapshot is frozen and independent', () => {
    obs._testReset();
    obs.observe('TEST_CODE');
    const snap1 = obs.snapshot();
    obs.observe('TEST_CODE');
    const snap2 = obs.snapshot();

    // snap1 should still be unchanged
    assert.deepStrictEqual(snap1, { TEST_CODE: 1 });
    assert.deepStrictEqual(snap2, { TEST_CODE: 2 });

    // Snapshot should be frozen
    assert.throws(
      () => { snap1.TEST_CODE = 999; },
      (err) => err instanceof TypeError
    );
  });

  await t.test('invalid codes are silently ignored', () => {
    obs._testReset();

    // Invalid codes (should be silently ignored, not logged or errored)
    obs.observe(''); // empty
    obs.observe('test_lowercase'); // lowercase
    obs.observe('TEST-DASH'); // dash
    obs.observe('TEST CODE'); // space
    obs.observe('A' + '0'.repeat(64)); // 65 chars (too long)
    obs.observe('TEST_CODE_1\x00SECRET'); // null byte
    obs.observe(null); // null
    obs.observe(undefined); // undefined
    obs.observe(123); // number
    obs.observe({ code: 'TEST' }); // object

    // Valid code should still work
    obs.observe('VALID_CODE');

    const snap = obs.snapshot();
    assert.deepStrictEqual(snap, { VALID_CODE: 1 });
  });

  await t.test('valid code patterns', () => {
    obs._testReset();

    const validCodes = [
      'A',
      'A0',
      'ABC_123',
      'TEST_CODE_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789', // 43 chars, all valid
      '_UNDERSCORE_ONLY',
      '123_NUMBERS',
      'A' + '0'.repeat(62) + 'Z', // 64 chars exactly
    ];

    validCodes.forEach((code) => {
      obs.observe(code);
    });

    const snap = obs.snapshot();
    validCodes.forEach((code) => {
      assert.strictEqual(snap[code], 1, `${code} should have count 1`);
    });
  });

  await t.test('code count limit and overflow behavior', () => {
    obs._testReset();

    // Add MAX_CODES different codes
    for (let i = 0; i < MAX_CODES; i++) {
      obs.observe(`CODE_${String(i).padStart(3, '0')}`);
    }

    let snap = obs.snapshot();
    assert.strictEqual(Object.keys(snap).length, MAX_CODES);

    // Try to add a new code when at limit
    obs.observe('NEW_CODE_SHOULD_OVERFLOW');

    snap = obs.snapshot();
    // Should have MAX_CODES codes still, plus OVERFLOW_CODE
    assert.strictEqual(snap[OVERFLOW_CODE], 1);
    assert.strictEqual(snap.NEW_CODE_SHOULD_OVERFLOW, undefined);
    assert.strictEqual(Object.keys(snap).length, MAX_CODES + 1);

    // Further overflow attempts
    obs.observe('ANOTHER_OVERFLOW');
    obs.observe('YET_ANOTHER_OVERFLOW');

    snap = obs.snapshot();
    assert.strictEqual(snap[OVERFLOW_CODE], 3);
    assert.strictEqual(Object.keys(snap).length, MAX_CODES + 1);
  });

  await t.test('snapshot returns new frozen object each time', () => {
    obs._testReset();
    obs.observe('TEST');

    const snap1 = obs.snapshot();
    const snap2 = obs.snapshot();

    assert.notStrictEqual(snap1, snap2); // Different objects
    assert.deepStrictEqual(snap1, snap2); // Same content
  });
});

test('testControlObservation - test context reset', async (t) => {
  const controller = createMockController(true);
  const obs = createTestControlObservation({ runtimeController: controller });

  await t.test('_testReset() requires NODE_TEST_CONTEXT', () => {
    // Save original env
    const originalEnv = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;

    try {
      assert.throws(
        () => obs._testReset(),
        (err) => err instanceof Error && err.message.includes('NODE_TEST_CONTEXT')
      );
    } finally {
      // Restore env (it should be set by test runner)
      if (originalEnv !== undefined) process.env.NODE_TEST_CONTEXT = originalEnv;
      else delete process.env.NODE_TEST_CONTEXT;
    }
  });

  await t.test('_testReset() clears state when NODE_TEST_CONTEXT is set', () => {
    process.env.NODE_TEST_CONTEXT = '1';
    obs.observe('CODE_A');
    obs.observe('CODE_B');

    let snap = obs.snapshot();
    assert.strictEqual(Object.keys(snap).length, 2);

    obs._testReset();

    snap = obs.snapshot();
    assert.deepStrictEqual(snap, {});
  });

  await t.test('_testReset() on inactive controller is no-op', () => {
    const inactiveController = createMockController(false);
    const inactiveObs = createTestControlObservation({ runtimeController: inactiveController });

    process.env.NODE_TEST_CONTEXT = '1';

    // Should not throw
    inactiveObs._testReset();

    // Snapshot should still be empty
    assert.deepStrictEqual(inactiveObs.snapshot(), {});
  });
});

test('testControlObservation - pattern matching', async (t) => {
  await t.test('CODE_PATTERN validates correctly', () => {
    const valid = [
      'A',
      'TEST_CODE',
      'TEST_CODE_123',
      'A0B1C2_3_4_5',
      '_UNDERSCORE',
      '123_456_789',
      'A' + '0'.repeat(62) + 'Z', // 64 chars
    ];

    const invalid = [
      '',
      'a', // lowercase
      'Test_Code', // mixed case
      'TEST-CODE', // dash
      'TEST CODE', // space
      'TEST_CODE@', // special char
      'A' + '0'.repeat(63) + 'Z', // 65 chars (too long)
    ];

    valid.forEach((code) => {
      assert(CODE_PATTERN.test(code), `${code} should match pattern`);
    });

    invalid.forEach((code) => {
      assert(!CODE_PATTERN.test(code), `${code} should NOT match pattern`);
    });
  });
});

test('testControlObservation - no runtime controller provided', async (t) => {
  const obs = createTestControlObservation({});

  await t.test('treats as inactive when no controller provided', () => {
    obs.observe('TEST_CODE');
    const snap = obs.snapshot();
    assert.deepStrictEqual(snap, {});
  });
});

test('testControlObservation - default runtime controller', async (t) => {
  const obs = createTestControlObservation({ runtimeController: null });

  await t.test('treats null controller as inactive', () => {
    obs.observe('TEST_CODE');
    const snap = obs.snapshot();
    assert.deepStrictEqual(snap, {});
  });
});

test('testControlObservation - module-level functions (no global symbol)', async (t) => {
  // Ensure no global symbol exists
  const symbol = Symbol.for('xiaoji.testControlRuntimeController');
  const originalValue = globalThis[symbol];
  delete globalThis[symbol];

  try {
    await t.test('module-level observe() is no-op when no global symbol', () => {
      for (let i = 0; i < 10000; i++) {
        observe('TEST_CODE');
      }
    });

    await t.test('module-level snapshot() returns empty when no global symbol', () => {
      const snap = snapshot();
      assert.deepStrictEqual(snap, {});
    });

    await t.test('calling observe many times does not create state', () => {
      for (let i = 0; i < 10000; i++) {
        observe(`CODE_${i % 100}`);
      }
      assert.deepStrictEqual(snapshot(), {});
    });
  } finally {
    // Restore original value if it existed
    if (originalValue !== undefined) {
      globalThis[symbol] = originalValue;
    }
  }
});

test('testControlObservation - module-level functions (with mock global symbol)', async (t) => {
  const symbol = Symbol.for('xiaoji.testControlRuntimeController');
  const originalValue = globalThis[symbol];

  try {
    await t.test('module-level functions work with mock global controller', () => {
      process.env.NODE_TEST_CONTEXT = '1';

      // Set up mock global controller
      const mockController = Object.freeze({ active: true });
      globalThis[symbol] = mockController;

      // Module-level functions should now count
      observe('TEST_A');
      observe('TEST_B');
      observe('TEST_A');

      const snap = snapshot();
      assert.deepStrictEqual(snap, {
        TEST_A: 2,
        TEST_B: 1,
      });

      // Reset for next test
      _testReset();
      assert.deepStrictEqual(snapshot(), {});
    });

    await t.test('invalid codes are ignored at module level', () => {
      const mockController = Object.freeze({ active: true });
      globalThis[symbol] = mockController;

      _testReset();

      observe('');
      observe('lowercase');
      observe('TEST-DASH');
      observe(null);
      observe('VALID_CODE');

      const snap = snapshot();
      assert.deepStrictEqual(snap, { VALID_CODE: 1 });

      _testReset();
    });

    await t.test('module-level snapshot is frozen', () => {
      const mockController = Object.freeze({ active: true });
      globalThis[symbol] = mockController;

      _testReset();
      observe('TEST_CODE');

      const snap = snapshot();
      assert.throws(
        () => { snap.TEST_CODE = 999; },
        (err) => err instanceof TypeError
      );

      _testReset();
    });

    await t.test('module-level code count limit works', () => {
      const mockController = Object.freeze({ active: true });
      globalThis[symbol] = mockController;

      _testReset();

      // Add MAX_CODES different codes
      for (let i = 0; i < MAX_CODES; i++) {
        observe(`CODE_${String(i).padStart(3, '0')}`);
      }

      let snap = snapshot();
      assert.strictEqual(Object.keys(snap).length, MAX_CODES);

      // Overflow
      observe('NEW_CODE_SHOULD_OVERFLOW');
      snap = snapshot();
      assert.strictEqual(snap[OVERFLOW_CODE], 1);
      assert(!snap.NEW_CODE_SHOULD_OVERFLOW);

      _testReset();
    });

    await t.test('module-level _testReset requires NODE_TEST_CONTEXT', () => {
      const mockController = Object.freeze({ active: true });
      globalThis[symbol] = mockController;

      const savedEnv = process.env.NODE_TEST_CONTEXT;
      delete process.env.NODE_TEST_CONTEXT;

      try {
        assert.throws(
          () => _testReset(),
          (err) => err instanceof Error && err.message.includes('NODE_TEST_CONTEXT')
        );
      } finally {
        if (savedEnv !== undefined) process.env.NODE_TEST_CONTEXT = savedEnv;
      }
    });

    await t.test('module-level inactive controller returns empty snapshots', () => {
      const inactiveController = Object.freeze({ active: false });
      globalThis[symbol] = inactiveController;

      observe('TEST_CODE');
      assert.deepStrictEqual(snapshot(), {});
    });

    await t.test('getGlobalRuntimeController returns the global symbol value', () => {
      const mockController = Object.freeze({ active: true, test: 'value' });
      globalThis[symbol] = mockController;

      const controller = getGlobalRuntimeController();
      assert.strictEqual(controller, mockController);

      const noController = getGlobalRuntimeController();
      delete globalThis[symbol];
      assert.strictEqual(getGlobalRuntimeController(), null);
    });
  } finally {
    // Clean up: restore original value or remove symbol
    if (originalValue !== undefined) {
      globalThis[symbol] = originalValue;
    } else {
      delete globalThis[symbol];
    }
    // Clean up env
    if (process.env.NODE_TEST_CONTEXT === '1') {
      delete process.env.NODE_TEST_CONTEXT;
    }
  }
});

test('testControlObservation - no require of testControlRuntimeBootstrap', async (t) => {
  await t.test('module source does not require testControlRuntimeBootstrap', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const modulePath = path.join(__dirname, '..', 'src', 'platform', 'testControlObservation.js');
    const source = fs.readFileSync(modulePath, 'utf8');

    // Should not require testControlRuntimeBootstrap
    assert(!source.includes('testControlRuntimeBootstrap'),
      'Module should not require testControlRuntimeBootstrap');
  });
});
