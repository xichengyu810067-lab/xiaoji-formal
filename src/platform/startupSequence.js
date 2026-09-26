'use strict';

async function startRuntime({ preflightPublic, preflightPrivate, shouldDeploy, deploy, login }) {
  await preflightPublic();
  await preflightPrivate();
  if (shouldDeploy()) await deploy();
  await login();
}

module.exports = { startRuntime };
