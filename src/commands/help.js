const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

const commandGroups = [
  {
    title: '一般與個人化',
    commands: [
      ['/ping', '查看小吉延遲'],
      ['/fortune', '抽一則小吉籤'],
      ['/roll sides count', '擲骰子'],
      ['/weather city', '查詢城市或臺灣縣市行政區天氣'],
      ['/poll question option1 option2', '建立按鈕投票'],
      ['/remind time message', '設定提醒'],
      ['/calendar add/list/delete', '使用個人行事曆'],
      ['/set-welcome channel', '設定新人歡迎頻道（需適當權限）'],
      ['/status', '查看小吉狀態'],
      ['/chat-style current/set', '查看或永久變更跨伺服器對話風格'],
      ['/romance start/stop/status', '開啟、關閉或查看跨伺服器文字戀愛模式'],
      ['/about', '查看專案資訊'],
      ['/help', '顯示指令說明'],
    ],
  },
  {
    title: '吉幣與遊戲',
    commands: [
      ['/coins user', '查詢吉幣餘額'],
      ['/daily', '依台灣日期每日簽到一次，跨伺服器共用'],
      ['/leaderboard', '查看伺服器吉幣排行榜'],
      ['/shop list/buy/purchases', '瀏覽或購買普通、精品商品，並查看自己的購買紀錄'],
      ['/buy', '使用吉幣購買商品'],
      ['/inventory', '查看跨伺服器共用的個人背包'],
      ['/work list/start/start-venue/submit/submissions/edit/delete/payroll', '工作提交與吉幣薪資系統'],
      ['/bank balance/deposit/withdraw/interest', '小吉銀行系統'],
      ['/exchange balance/buy-chips/cashout/history', '籌碼與吉幣兌換區'],
      ['/casino-lobby guide/stay/betting-area', '賭場大廳導覽、下注區與住宿'],
      ['/duel-tower weapons/enter/profile/history', '使用吉幣商店武器挑戰決鬥塔台'],
      ['/casino dice/slots/blackjack/roulette/baccarat/poker/loan-borrow/loan-repay/loan-status/history', '使用籌碼遊玩賭場'],
      ['/casino-venue menu/order/recipe/make/serve', '餐廳、吧檯與服務流程'],
      ['/luxury list/buy/inventory/history', '獨立奢侈品商店街'],
      ['/pawn quote/sell/active/redeem/history', '奢侈品當鋪與贖回'],
      ['/games play', '建立瀏覽器遊戲的一次性連結'],
      ['/board start/join/leave/status/stop', '在同一頻道建立、加入、離開或查看棋盤與推理遊戲；結束限制依遊戲狀態而定'],
    ],
  },
  {
    title: '社群活動',
    commands: [
      ['/word-chain start/stop/status', '文字接龍'],
      ['/number-chain start/stop/status', '安全整數與算式數字接龍'],
      ['/daily-riddle enable/disable/status', '每日猜謎'],
      ['/daily-discussion enable/disable/status/run-now', '每日議題'],
    ],
  },
];

module.exports = {
  data: new SlashCommandBuilder().setName('help').setDescription('列出小吉可用指令'),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('小吉指令說明')
      .setDescription('以下是公開版本目前可用的主要指令。')
      .setColor(0x57a6ff);

    for (const group of commandGroups) {
      let chunk = '';
      let part = 1;
      for (const [usage, description] of group.commands) {
        const line = `\`${usage}\` - ${description}\n`;
        if (chunk.length + line.length > 1000) {
          embed.addFields({ name: part === 1 ? group.title : `${group.title} ${part}`, value: chunk.trim() });
          chunk = '';
          part += 1;
        }
        chunk += line;
      }
      if (chunk) embed.addFields({ name: part === 1 ? group.title : `${group.title} ${part}`, value: chunk.trim() });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
