'use strict';

const { isCanonicalRoute } = require('./discordRoute');
const { createTestControlInventory } = require('./testControlInventory');
const { TestControlError } = require('./testControlPolicy');

const SYNTHETIC_EGRESS_SYMBOL = Symbol.for('xiaoji.liveTestSyntheticEgress');

const DIAGNOSTIC_PHASES = new Set([
  'identity_preflight',
  'runtime_preflight',
  'login_wait_ready',
  'ready_entry',
]);
const DIAGNOSTIC_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER']);
const DIAGNOSTIC_ROUTE_FAMILIES = new Set([
  'EMPTY',
  'ABSOLUTE',
  'API_PREFIX',
  'GATEWAY',
  'CURRENT_APPLICATION',
  'APPLICATION',
  'USER_GUILDS',
  'USER',
  'OAUTH',
  'GUILD',
  'CHANNEL',
  'OTHER',
]);
const DIAGNOSTIC_CALLERS = new Set([
  'WS_GATEWAY',
  'CLIENT_APPLICATION',
  'GUILD_MANAGER',
  'CHANNEL_MANAGER',
  'USER_MANAGER',
  'TEST_CONTROL_PREFLIGHT',
  'UNKNOWN',
]);

function deny(policy, code, operation) {
  policy.reporter.deny(code, operation);
  throw new TestControlError(code);
}

function normalizeMethod(value) {
  return String(value || 'GET').toUpperCase();
}

function diagnosticMethod(value) {
  const method = normalizeMethod(value);
  return DIAGNOSTIC_METHODS.has(method) ? method : 'OTHER';
}

function diagnosticRouteFamily(fullRoute, route) {
  const raw = String(fullRoute || '');
  if (!raw) return 'EMPTY';
  if (/^https?:\/\//iu.test(raw)) return 'ABSOLUTE';
  if (/^\/api\/v\d+(?:\/|$)/iu.test(route)) return 'API_PREFIX';
  if (route === '/applications/@me') return 'CURRENT_APPLICATION';
  if (route === '/users/@me/guilds') return 'USER_GUILDS';
  if (route.startsWith('/gateway')) return 'GATEWAY';
  if (route.startsWith('/applications/')) return 'APPLICATION';
  if (route.startsWith('/users/')) return 'USER';
  if (route.startsWith('/oauth2/')) return 'OAUTH';
  if (route.startsWith('/guilds/')) return 'GUILD';
  if (route.startsWith('/channels/')) return 'CHANNEL';
  return 'OTHER';
}

function diagnosticCaller(captureStack) {
  let stack = '';
  try { stack = String(captureStack() || '').replaceAll('\\', '/'); } catch { return 'UNKNOWN'; }
  if (stack.includes('fetchGatewayInformation') && stack.includes('@discordjs/ws/')) return 'WS_GATEWAY';
  if (stack.includes('ClientApplication.fetch') && stack.includes('/structures/ClientApplication.js')) {
    return 'CLIENT_APPLICATION';
  }
  if (stack.includes('GuildManager.fetch') && stack.includes('/managers/GuildManager.js')) return 'GUILD_MANAGER';
  if (stack.includes('ChannelManager.fetch') && stack.includes('/managers/ChannelManager.js')) return 'CHANNEL_MANAGER';
  if (stack.includes('UserManager.fetch') && stack.includes('/managers/UserManager.js')) return 'USER_MANAGER';
  if (stack.includes('preflightTestIdentity') && stack.includes('/platform/testControlPolicy.js')) {
    return 'TEST_CONTROL_PREFLIGHT';
  }
  return 'UNKNOWN';
}

function diagnosticCode({ phase, method, routeFamily, caller }) {
  const safePhase = DIAGNOSTIC_PHASES.has(phase) ? phase.toUpperCase() : 'IDENTITY_PREFLIGHT';
  const safeMethod = DIAGNOSTIC_METHODS.has(method) ? method : 'OTHER';
  const safeRoute = DIAGNOSTIC_ROUTE_FAMILIES.has(routeFamily) ? routeFamily : 'OTHER';
  const safeCaller = DIAGNOSTIC_CALLERS.has(caller) ? caller : 'UNKNOWN';
  return `TEST_EGRESS_${safeMethod}_${safePhase}_${safeRoute}_${safeCaller}`;
}

function interactionInventorySource(interaction) {
  const command = String(interaction?.commandName || '');
  return /^[a-z0-9_-]{1,64}$/iu.test(command) ? `interaction:/${command}` : 'interaction:component';
}

// As with the synthetic actor registry, production only observes an absent global. The private
// harness must bind the adapter to this exact verified policy before it can affect a request.
function getSyntheticEgressAdapter(policy) {
  const adapter = globalThis[SYNTHETIC_EGRESS_SYMBOL];
  if (!adapter || adapter.active !== true || adapter.dataRoot !== policy.dataRoot ||
      adapter.expectedApplicationId !== policy.expectedApplicationId || typeof adapter.prepareRequest !== 'function') {
    return null;
  }
  return adapter;
}

function createTestControlEgress(policy, {
  now = () => Date.now(),
  interactionTtlMs = 20 * 60 * 1000,
  captureStack = () => new Error().stack,
  isStopping = () => false,
  startupDiagnostics = null,
} = {}) {
  const interactions = new Map();
  const channelGuilds = new Map();
  let diagnosticPhase = 'identity_preflight';
  let inventory = null;

  function prune() {
    const current = now();
    for (const [id, record] of interactions) if (record.expiresAt <= current) interactions.delete(id);
  }

  function bindInteraction(interaction) {
    prune();
    if (!interaction?.id || !interaction?.token || !policy.allowsGuild(interaction.guildId) ||
        !policy.allowsChannel(interaction.channelId) || !policy.allowsActor(interaction.user?.id)) {
      deny(policy, 'TEST_INTERACTION_SCOPE_DENIED', 'bind_interaction');
    }
    interactions.set(String(interaction.id), {
      token: String(interaction.token),
      guildId: String(interaction.guildId),
      channelId: String(interaction.channelId),
      source: interactionInventorySource(interaction),
      expiresAt: now() + interactionTtlMs,
    });
    return true;
  }

  function rememberChannel(channelId, guildId) {
    const channel = String(channelId || '');
    const guild = String(guildId || '');
    if (!policy.allowsChannel(channel) || !policy.allowsGuild(guild)) return false;
    channelGuilds.set(channel, guild);
    inventory?.rememberChannel(channel, guild);
    return true;
  }

  function rememberChannelResponse(route, method, result) {
    const match = normalizeMethod(method) === 'GET' && route.match(/^\/channels\/(\d{16,22})$/u);
    if (match) rememberChannel(match[1], result?.guild_id);
  }

  function inventoryMessageRequest(route, method) {
    if (!inventory) return null;
    const verb = normalizeMethod(method);
    let match = verb === 'POST' && route.match(/^\/channels\/(\d{16,22})\/messages$/u);
    if (match) {
      return {
        guildId: channelGuilds.get(match[1]),
        channelId: match[1],
        source: 'discord-rest:channel-message',
      };
    }
    match = route.match(/^\/webhooks\/(\d{16,22})\/([^/]+)(?:\/messages\/@original)?$/u);
    if (!match || match[1] !== policy.expectedApplicationId ||
        !((verb === 'POST' && !route.endsWith('/messages/@original')) ||
          (verb === 'PATCH' && route.endsWith('/messages/@original')))) return null;
    const interaction = [...interactions.values()].find((record) => record.token === match[2]);
    if (!interaction) return null;
    return {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      source: interaction.source,
    };
  }

  function syntheticOutputChannel(route, method) {
    const direct = normalizeMethod(method) === 'POST' && route.match(/^\/channels\/(\d{16,22})\/messages$/u);
    if (direct) return direct[1];
    const webhook = route.match(/^\/webhooks\/(\d{16,22})\/([^/]+)(?:\/messages\/@original)?$/u);
    if (webhook && webhook[1] === policy.expectedApplicationId) {
      return [...interactions.values()].find((record) => record.token === webhook[2])?.channelId || null;
    }
    const interaction = route.match(/^\/interactions\/(\d{16,22})\/([^/]+)\/callback$/u);
    if (interaction && normalizeMethod(method) === 'POST') {
      const record = interactions.get(interaction[1]);
      return record?.token === interaction[2] ? record.channelId : null;
    }
    return null;
  }

  function enableInventory(options = {}) {
    if (inventory) return inventory;
    const created = createTestControlInventory(policy, options);
    for (const [channelId, guildId] of channelGuilds) created.rememberChannel(channelId, guildId);
    inventory = created;
    return inventory;
  }

  function setDiagnosticPhase(phase) {
    if (!DIAGNOSTIC_PHASES.has(phase)) throw new TestControlError('TEST_DIAGNOSTIC_PHASE_INVALID');
    diagnosticPhase = phase;
    return true;
  }

  function allowRequest({ fullRoute, method }) {
    prune();
    if (isStopping()) deny(policy, 'TEST_STOPPING_EGRESS_DENIED', 'discord_rest');
    const rawRoute = String(fullRoute || '');
    if (!isCanonicalRoute(rawRoute)) deny(policy, 'TEST_ROUTE_NORMALIZATION_DENIED', 'discord_rest');
    const route = rawRoute.split('?')[0];
    const verb = normalizeMethod(method);
    if (verb === 'GET' && ['/gateway', '/gateway/bot'].includes(route)) return true;
    if (verb === 'GET' && [
      '/oauth2/applications/@me',
      '/users/@me',
      '/users/%40me',
    ].includes(rawRoute)) return true;

    let match = route.match(/^\/channels\/(\d{16,22})(?:\/|$)/);
    if (match) {
      if (!policy.allowsChannel(match[1])) deny(policy, 'TEST_CHANNEL_EGRESS_DENIED', 'discord_rest');
      return true;
    }

    match = route.match(/^\/guilds\/(\d{16,22})(?:\/|$)/);
    if (match) {
      if (!policy.allowsGuild(match[1])) deny(policy, 'TEST_GUILD_EGRESS_DENIED', 'discord_rest');
      if (verb !== 'GET') deny(policy, 'TEST_GUILD_MUTATION_DENIED', 'discord_rest');
      return true;
    }

    if (/^\/users\/@me\/guilds\//.test(route)) deny(policy, 'TEST_GUILD_LEAVE_DENIED', 'discord_rest');
    if (route === '/users/@me/channels' && verb !== 'GET') deny(policy, 'TEST_DM_DENIED', 'discord_rest');
    match = route.match(/^\/users\/(\d{16,22})$/);
    if (verb === 'GET' && match) {
      if (!policy.allowsActor(match[1])) deny(policy, 'TEST_USER_READ_DENIED', 'discord_rest');
      return true;
    }

    match = route.match(/^\/interactions\/(\d{16,22})\/([^/]+)\/callback$/);
    if (match) {
      const record = interactions.get(match[1]);
      if (!record || record.token !== match[2]) deny(policy, 'TEST_CALLBACK_DENIED', 'discord_rest');
      return true;
    }

    match = route.match(/^\/webhooks\/(\d{16,22})\/([^/]+)(?:\/|$)/);
    if (match) {
      if (match[1] !== policy.expectedApplicationId ||
          ![...interactions.values()].some((record) => record.token === match[2])) {
        deny(policy, 'TEST_WEBHOOK_DENIED', 'discord_rest');
      }
      return true;
    }

    match = route.match(/^\/applications\/(\d{16,22})\/guilds\/(\d{16,22})\/commands(?:\/|$)/);
    if (match) {
      if (match[1] !== policy.expectedApplicationId || !policy.allowsGuild(match[2])) {
        deny(policy, 'TEST_COMMAND_ROUTE_DENIED', 'discord_rest');
      }
      return true;
    }
    if (/^\/applications\/\d{16,22}\/commands(?:\/|$)/.test(route)) {
      deny(policy, 'TEST_GLOBAL_COMMAND_DENIED', 'discord_rest');
    }

    if (verb === 'GET') {
      policy.reporter.deny(diagnosticCode({
        phase: diagnosticPhase,
        method: diagnosticMethod(verb),
        routeFamily: diagnosticRouteFamily(fullRoute, route),
        caller: diagnosticCaller(captureStack),
      }), 'discord_rest_diagnostic');
      throw new TestControlError('TEST_UNKNOWN_READ_DENIED');
    }
    deny(policy, 'TEST_UNKNOWN_MUTATION_DENIED', 'discord_rest');
  }

  function install(rest) {
    if (!rest || typeof rest.request !== 'function') throw new TestControlError('TEST_REST_UNAVAILABLE');
    if (rest.__xiaojiTestControlInstalled) return rest;
    const original = rest.request.bind(rest);
    Object.defineProperty(rest, '__xiaojiTestControlInstalled', { value: true });
    rest.request = async (options) => {
      const route = String(options?.fullRoute || '').split('?')[0];
      const method = normalizeMethod(options?.method);
      const isGatewayRequest = method === 'GET' && route === '/gateway/bot';
      let pending = null;
      let synthetic = null;
      try {
        allowRequest(options);
        const adapter = getSyntheticEgressAdapter(policy);
        synthetic = adapter?.prepareRequest(options, { route, method, policy,
          outputChannelId: syntheticOutputChannel(route, method) }) || null;
        if (synthetic?.virtual) {
          adapter.afterResponse?.(synthetic.response, { route, method, virtual: true });
          return synthetic.response;
        }
        const outgoing = synthetic?.options || options;
        const request = inventoryMessageRequest(route, method);
        if (request) pending = inventory.beginMessage(request);
        const result = await original(outgoing);
        rememberChannelResponse(route, method, result);
        if (pending !== null) {
          const sequence = pending;
          pending = null;
          inventory.resolveMessage(sequence, result);
        }
        adapter?.afterResponse?.(result, { route, method, virtual: false });
        if (isGatewayRequest && startupDiagnostics?.currentPhase?.() === 'LOGIN_REST') {
          startupDiagnostics.enterPhase('LOGIN_GATEWAY');
        }
        return result;
      } catch (error) {
        if (pending !== null) {
          const sequence = pending;
          pending = null;
          inventory.failMessage(sequence, error?.code);
        }
        getSyntheticEgressAdapter(policy)?.afterFailure?.(error, { route, method, synthetic });
        const deferToLogin = isGatewayRequest &&
          startupDiagnostics?.isTrustedGatewayUnauthorized?.(error) === true;
        if (!deferToLogin) startupDiagnostics?.reportFailure?.(error);
        throw error;
      }
    };
    return rest;
  }

  return Object.freeze({
    allowRequest,
    bindInteraction,
    enableInventory,
    install,
    interactionCount: () => interactions.size,
    setDiagnosticPhase,
  });
}

module.exports = { SYNTHETIC_EGRESS_SYMBOL, createTestControlEgress, getSyntheticEgressAdapter };
