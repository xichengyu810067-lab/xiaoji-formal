'use strict';

async function startRuntime({
  preflightControl = async () => {},
  preflightPublic,
  preflightPrivate,
  shouldDeploy,
  deploy,
  login,
  testControlDiagnostics = null,
  startupDiagnostics = null,
  runtimeControl = null,
}) {
  const assertRunning = () => runtimeControl?.assertRunning?.() ?? true;
  assertRunning();
  startupDiagnostics?.enterPhase?.('IDENTITY_PREFLIGHT');
  testControlDiagnostics?.setDiagnosticPhase?.('identity_preflight');
  await preflightControl();
  assertRunning();
  startupDiagnostics?.enterPhase?.('RUNTIME_PREFLIGHT');
  testControlDiagnostics?.setDiagnosticPhase?.('runtime_preflight');
  await preflightPublic();
  assertRunning();
  await preflightPrivate();
  assertRunning();
  if (shouldDeploy()) {
    await deploy();
    assertRunning();
  }
  startupDiagnostics?.enterPhase?.('LOGIN_REST');
  testControlDiagnostics?.setDiagnosticPhase?.('login_wait_ready');
  assertRunning();
  await login();
  assertRunning();
  startupDiagnostics?.enterPhase?.('READY_WAIT');
}

module.exports = { startRuntime };
