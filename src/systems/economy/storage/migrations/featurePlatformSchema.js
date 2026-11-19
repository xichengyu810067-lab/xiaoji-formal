const { getColumnNames, getRow, getRows, hasUniqueIndex, verifyTableContract } = require('../sqlHelpers');

// Verifies, after every open, the contracts of the community, game, release announcement and feature
// platform tables: column shapes, CHECK constraints, foreign keys and unique keys.
function verifyFeaturePlatformSchema(db) {
  const text = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'TEXT',
    notNull,
    defaultValue,
    primaryKeyPosition,
  });
  const integer = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'INTEGER',
    notNull,
    defaultValue,
    primaryKeyPosition,
  });
  const tableContracts = {
    release_announcement_state: {
      columns: {
        repository: text(true, null, 1), baseline_release_id: text(true), baseline_published_at: text(true),
        cursor_release_id: text(true), cursor_published_at: text(true), created_at: text(true), updated_at: text(true),
      },
      checks: [],
    },
    feature_guild_settings: {
      columns: {
        guild_id: text(true, null, 1),
        feature_key: text(true, null, 2),
        enabled: integer(true, '0'),
        channel_id: text(),
        config_json: text(true, "'{}'"),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: ['check(enabledin(0,1))'],
    },
    feature_outbox: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        feature_key: text(true),
        event_type: text(true),
        dedupe_key: text(true),
        payload_json: text(true),
        status: text(true, "'pending'"),
        available_at: text(true),
        attempt_count: integer(true, '0'),
        claimed_by: text(),
        claimed_at: text(),
        lease_until: text(),
        delivered_at: text(),
        last_error: text(),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: ["check(statusin('pending','processing','delivered'))"],
    },
    feature_outbox_dead_letters: {
      columns: {
        id: integer(false, null, 1),
        original_event_id: integer(true),
        guild_id: text(true),
        feature_key: text(true),
        event_type: text(true),
        dedupe_key: text(true),
        payload_json: text(true),
        attempt_count: integer(true),
        last_error: text(true),
        dead_letter_reason: text(true),
        created_at: text(true),
      },
      checks: [],
    },
    reward_grants: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        user_id: text(true),
        source_type: text(true),
        source_id: text(true),
        reward_kind: text(true),
        amount: integer(true),
        metadata: text(),
        transaction_id: integer(),
        created_at: text(true),
      },
      checks: ['check(amount>0)'],
    },
    feature_usage_daily: {
      columns: {
        usage_date: text(true, null, 1),
        feature_key: text(true, null, 2),
        metric_key: text(true, null, 3),
        usage_count: integer(true, '0'),
        updated_at: text(true),
      },
      checks: ['check(usage_count>=0)'],
    },
    feature_health: {
      columns: {
        feature_key: text(false, null, 1),
        status: text(true),
        detail: text(),
        updated_at: text(true),
      },
      checks: ["check(statusin('normal','maintenance','broken'))"],
    },
    user_chat_preferences: {
      columns: {
        user_id: text(true, null, 1),
        style: text(true, "'cute'"),
        updated_at: text(true),
      },
      checks: ["check(stylein('cute','mature_sister','ceo','cold','tsundere','yandere'))"],
    },
    user_romance_preferences: {
      columns: {
        user_id: text(true, null, 1),
        enabled: integer(true, '0'),
        started_at: text(),
        updated_at: text(true),
      },
      checks: ['check(enabledin(0,1))'],
    },
    game_sessions: {
      columns: {
        id: text(true, null, 1), launch_token_hash: text(true), access_token_hash: text(), launch_consumed_at: text(),
        user_id: text(true), guild_id: text(true), channel_id: text(true), game_type: text(true), difficulty: text(true),
        seed: text(true), state_json: text(true), status: text(true, "'active'"), action_count: integer(true, '0'),
        score: integer(true, '0'), reward_amount: integer(true, '0'), expires_at: text(true), created_at: text(true),
        updated_at: text(true), completed_at: text(),
      },
      checks: ["check(game_typein('tetris','number-match','sudoku'))", "check(difficultyin('easy','normal','complex','hard'))", "check(statusin('active','completed','expired','failed'))", 'check(action_count>=0andaction_count<=500)', 'check(score>=0andscore<=20000)', 'check(reward_amount>=0andreward_amount<=1000)'],
    },
    game_actions: {
      columns: { session_id: text(true, null, 1), action_index: integer(true, null, 2), action_hash: text(true), state_json: text(true), created_at: text(true) },
      checks: ['check(action_index>=0andaction_index<500)'],
    },
    game_rewards: {
      columns: { session_id: text(true, null, 1), reward_key: text(true), status: text(true, "'pending'"), amount: integer(true), created_at: text(true), updated_at: text(true) },
      checks: ["check(statusin('pending','granted','no_reward'))", 'check(amount>=0andamount<=1000)'],
    },
    github_releases: {
      columns: {
        release_id: text(true, null, 1), repository: text(true), tag_name: text(true),
        version_major: integer(true), version_minor: integer(true), version_patch: integer(true),
        release_name: text(true), body_summary: text(true), html_url: text(true), metadata_digest: text(true),
        published_at: text(true), discovered_at: text(true), updated_at: text(true),
      },
      checks: [
        'check(version_major>=0)', 'check(version_minor>=0)', 'check(version_patch>=0)',
        'check(length(metadata_digest)=64)',
      ],
    },
    release_announcement_deliveries: {
      columns: {
        release_id: text(true, null, 1), guild_id: text(true, null, 2), status: text(true, "'pending'"),
        attempt_count: integer(true, '0'), next_attempt_at: text(true), lease_owner: text(), lease_until: text(), last_error: text(),
        nonce: text(true), delivered_at: text(), created_at: text(true), updated_at: text(true),
      },
      checks: [
        "check(statusin('pending','processing','delivered','dead_letter','suppressed'))",
        'check(attempt_count>=0andattempt_count<=5)',
      ],
    },
    text_chain_sessions: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        channel_id: text(true),
        status: text(true, "'active'"),
        corpus_version: text(true, "'2026.09.03-1'"),
        current_word: text(true),
        last_word: text(true),
        last_user_id: text(),
        revision: integer(true, '0'),
        started_by: text(true),
        stopped_by: text(),
        created_at: text(true),
        updated_at: text(true),
        stopped_at: text(),
        completed_at: text(),
      },
      checks: ["check(statusin('active','stopped','completed'))", 'check(revision>=0)'],
    },
    text_chain_entries: {
      columns: {
        id: integer(false, null, 1),
        session_id: integer(true),
        guild_id: text(true),
        channel_id: text(true),
        message_id: text(true),
        user_id: text(true),
        word: text(true),
        created_at: text(true),
      },
      checks: [],
    },
    number_chain_sessions: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        channel_id: text(true),
        status: text(true, "'active'"),
        expected_target: integer(true),
        last_user_id: text(),
        revision: integer(true, '0'),
        started_by: text(true),
        stopped_by: text(),
        created_at: text(true),
        updated_at: text(true),
        stopped_at: text(),
        completed_at: text(),
      },
      checks: ["check(statusin('active','stopped','completed'))", 'check(expected_target>=1andexpected_target<=9007199254740991)', 'check(revision>=0)'],
    },
    number_chain_entries: {
      columns: {
        id: integer(false, null, 1),
        session_id: integer(true),
        guild_id: text(true),
        channel_id: text(true),
        message_id: text(true),
        user_id: text(true),
        expression: text(true),
        result: integer(true),
        created_at: text(true),
      },
      checks: ['check(result>=1andresult<=9007199254740991)'],
    },
    daily_events: {
      columns: {
        id: integer(false, null, 1),
        guild_id: text(true),
        event_kind: text(true),
        local_date: text(true),
        riddle_id: text(),
        parent_channel_id: text(true),
        announcement_message_id: text(),
        thread_id: text(),
        answer_message_id: text(),
        status: text(true, "'claimed'"),
        window_start_at: text(true),
        window_end_at: text(true),
        publish_marker: text(true),
        answer_marker: text(true),
        published_at: text(),
        history_reconciled_at: text(),
        settled_at: text(),
        attempt_count: integer(true, '0'),
        publish_lease_owner: text(),
        publish_lease_until: text(),
        settle_lease_owner: text(),
        settle_lease_until: text(),
        last_error: text(),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: [
        "check(event_kindin('riddle','discussion'))",
        "check(statusin('claimed','published','published_late','settling','rewarding','settled','blocked','missed','failed'))",
        'check(attempt_count>=0)',
      ],
    },
    daily_event_messages: {
      columns: {
        id: integer(false, null, 1),
        event_id: integer(true),
        guild_id: text(true),
        thread_id: text(true),
        message_id: text(true),
        user_id: text(true),
        created_at: text(true),
        eligible: integer(true, '0'),
        correct: integer(true, '0'),
      },
      checks: ['check(eligiblein(0,1))', 'check(correctin(0,1))'],
    },
    daily_event_participants: {
      columns: {
        event_id: integer(true, null, 1),
        guild_id: text(true),
        user_id: text(true, null, 2),
        eligible: integer(true, '0'),
        correct: integer(true, '0'),
        participation_reward_status: text(true, "'pending'"),
        correct_reward_status: text(true, "'pending'"),
        created_at: text(true),
        updated_at: text(true),
      },
      checks: [
        'check(eligiblein(0,1))',
        'check(correctin(0,1))',
        "check(participation_reward_statusin('pending','granted'))",
        "check(correct_reward_statusin('pending','granted','not_earned'))",
      ],
    },
  };

  for (const [tableName, contract] of Object.entries(tableContracts)) {
    verifyTableContract(db, tableName, contract.columns, contract.checks);
  }

  const preferenceColumns = getColumnNames(db, 'user_chat_preferences');
  if (JSON.stringify(preferenceColumns) !== JSON.stringify(['user_id', 'style', 'updated_at'])) {
    throw new Error('user_chat_preferences must contain only its global, non-message preference fields');
  }

  const romancePreferenceColumns = getColumnNames(db, 'user_romance_preferences');
  if (JSON.stringify(romancePreferenceColumns) !== JSON.stringify(['user_id', 'enabled', 'started_at', 'updated_at'])) {
    throw new Error('user_romance_preferences must contain only its global, non-message preference fields');
  }

  for (const [tableName, expected] of [
    ['game_sessions', ['id','launch_token_hash','access_token_hash','launch_consumed_at','user_id','guild_id','channel_id','game_type','difficulty','seed','state_json','status','action_count','score','reward_amount','expires_at','created_at','updated_at','completed_at']],
    ['game_actions', ['session_id','action_index','action_hash','state_json','created_at']],
    ['game_rewards', ['session_id','reward_key','status','amount','created_at','updated_at']],
  ]) {
    if (JSON.stringify(getColumnNames(db, tableName)) !== JSON.stringify(expected)) throw new Error(`${tableName} has an unsafe schema shape`);
  }
  for (const tableName of ['game_actions', 'game_rewards']) {
    const foreignKey = getRows(db, `PRAGMA foreign_key_list(${tableName})`).find((row) => row.table === 'game_sessions' && row.from === 'session_id' && row.to === 'id' && String(row.on_delete).toUpperCase() === 'CASCADE');
    if (!foreignKey) throw new Error(`${tableName} is missing its session foreign key`);
  }
  const releaseForeignKey = getRows(db, 'PRAGMA foreign_key_list(release_announcement_deliveries)')
    .find((row) => row.table === 'github_releases' && row.from === 'release_id' && row.to === 'release_id' && String(row.on_delete).toUpperCase() === 'CASCADE');
  if (!releaseForeignKey) throw new Error('release_announcement_deliveries is missing its release foreign key');
  const announcementStateForeignKeys = getRows(db, 'PRAGMA foreign_key_list(release_announcement_state)');
  for (const column of ['baseline_release_id', 'cursor_release_id']) {
    if (!announcementStateForeignKeys.some((row) => row.table === 'github_releases' && row.from === column && row.to === 'release_id')) {
      throw new Error(`release_announcement_state is missing its ${column} foreign key`);
    }
  }

  for (const [tableName, columns] of [
    ['feature_guild_settings', ['guild_id', 'feature_key']],
    ['feature_outbox', ['guild_id', 'feature_key', 'event_type', 'dedupe_key']],
    ['feature_outbox_dead_letters', ['original_event_id']],
    ['reward_grants', ['guild_id', 'user_id', 'source_type', 'source_id', 'reward_kind']],
    ['feature_usage_daily', ['usage_date', 'feature_key', 'metric_key']],
    ['text_chain_entries', ['message_id']],
    ['number_chain_entries', ['message_id']],
    ['daily_events', ['guild_id', 'event_kind', 'local_date']],
    ['daily_event_messages', ['event_id', 'message_id']],
    ['daily_event_participants', ['event_id', 'user_id']],
    ['game_sessions', ['launch_token_hash']],
    ['game_sessions', ['access_token_hash']],
    ['game_actions', ['session_id', 'action_index']],
    ['game_rewards', ['reward_key']],
    ['github_releases', ['repository', 'tag_name']],
    ['release_announcement_deliveries', ['release_id', 'guild_id']],
    ['release_announcement_deliveries', ['nonce']],
  ]) {
    if (!hasUniqueIndex(db, tableName, columns)) {
      throw new Error(`${tableName} is missing its required unique key`);
    }
  }

  const activeSessionIndex = getRow(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_text_chain_one_active_guild'"
  )?.sql;
  const normalizedActiveSessionIndex = String(activeSessionIndex || '')
    .toLowerCase()
    .replace(/[\s\"`\[\]]+/g, '');
  if (!normalizedActiveSessionIndex.includes("uniqueindexidx_text_chain_one_active_guildontext_chain_sessions(guild_id)wherestatus='active'")) {
    throw new Error('text_chain_sessions is missing the one-active-session-per-guild unique index');
  }
  const activeNumberSessionIndex = getRow(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_number_chain_one_active_guild'"
  )?.sql;
  const normalizedActiveNumberSessionIndex = String(activeNumberSessionIndex || '')
    .toLowerCase()
    .replace(/[\s\"`\[\]]+/g, '');
  if (!normalizedActiveNumberSessionIndex.includes("uniqueindexidx_number_chain_one_active_guildonnumber_chain_sessions(guild_id)wherestatus='active'")) {
    throw new Error('number_chain_sessions is missing the one-active-session-per-guild unique index');
  }
}

module.exports = {
  verifyFeaturePlatformSchema,
};
