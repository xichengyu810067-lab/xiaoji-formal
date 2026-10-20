'use strict';

// Addresses written with "https://" and a first character that is not ASCII, as a browser's own parser reads
// the run after "https://" (new URL('https://' + run)): the run is an address when the parser gives an IPv4 or
// IPv6 address, or a host of two labels or more whose last label is an ending (ASCII, the name of a top-level
// domain written in other letters, or "xn--" as written), and text when it refuses the run or gives a single
// label or a last label that is a sentence (runIsHost in src/platform/linkPolicy.js). The parser maps an
// ideographic full stop and the full-width and halfwidth stops to ".", look-alike letters (circled, squared,
// full-width) and full-width digits to ASCII ones, and drops invisible characters, so a number or a name
// written in them is a host a browser opens; when it refuses a run for an invisible character (a joiner, a tag
// character, a mark of direction), the run without them is read too, as a client of an older kind reads it.
//
// These rows are shared by the tests of the link rules, of the egress guard and of the AI reply policy. In
// each setting:
//   ADDRESSES            are replaced whole, and nothing of them is left: the fixed marker alone;
//   TEXT                 comes through unchanged ([text, why the run is no host]);
//   TEXT_WITH_A_NAME     keeps the text about "https://" and loses the name inside it ([input, expected]);
//   WITH_CONTEXT         an address with what stands around it, or a character the scheme step does not read
//                        as a part of the host ([input, expected]);
//   REMOVED_BY_DESIGN    read as an address, though they may be sentences ([input, expected]): a last label
//                        that is ASCII, or the name of a top-level domain, is a host for the parser, and
//                        nothing here can tell it from a sentence about "https://" that has a full stop in it.

const EVIL = '\u{24d4}\u{24e5}\u{24d8}\u{24db}'; // evil, in circled letters
const COM = '\u{24d2}\u{24de}\u{24dc}'; // com, in circled letters
const STOP = '\u{3002}'; // the ideographic full stop, which a browser reads as "."
const BACKSLASH = '\\';

const ADDRESSES = Object.freeze([
  // look-alike letters with the ideographic stop, with the path or port after them, and a squared ending
  `https://${EVIL}${STOP}${COM}`,
  `https://${EVIL}${STOP}${COM}/claim`,
  `https://${EVIL}${STOP}${COM}:443`,
  `https://${EVIL}${STOP}\u{1f132}\u{1f13e}\u{1f13c}`,
  `https://${EVIL}${STOP}com`,
  `https://${EVIL}\u{ff0e}com`,
  `https://${EVIL}\u{ff61}com`,
  // a user in front of the host
  'https://\u{300c}a@evil.com',
  `https://\u{300c}a@evil${STOP}com`,
  `https://\u{300c}a@${EVIL}${STOP}${COM}`,
  'https://\u{7532}@2130706433',
  'https://\u{7532}@0x7f000001/x',
  'https://\u{300c}a@[::1]/x',
  'https://\u{7532}@[2606:2800:220:1:248:1893:25c8:1946]:8080/x',
  // a number: decimal, hexadecimal and octal, in full-width digits, and written in four parts with stops
  'https://\u{ff12}\u{ff11}\u{ff13}\u{ff10}\u{ff17}\u{ff10}\u{ff16}\u{ff14}\u{ff13}\u{ff13}',
  'https://\u{ff12}\u{ff11}\u{ff13}\u{ff10}\u{ff17}\u{ff10}\u{ff16}\u{ff14}\u{ff13}\u{ff13}/x?y=1',
  'https://\u{ff10}x7f000001',
  'https://\u{ff10}x5db8d822/claim',
  'https://\u{ff10}\u{ff58}\u{ff15}\u{ff44}\u{ff42}\u{ff18}\u{ff44}\u{ff18}\u{ff12}\u{ff12}',
  'https://\u{ff10}17700000001',
  `https://\u{ff11}\u{ff12}\u{ff17}${STOP}\u{ff10}${STOP}\u{ff10}${STOP}\u{ff11}`,
  `https://\u{ff19}\u{ff13}${STOP}\u{ff11}\u{ff18}\u{ff14}${STOP}\u{ff12}\u{ff11}\u{ff16}${STOP}\u{ff13}\u{ff14}`,
  `https://\u{ff19}\u{ff13}${STOP}\u{ff11}\u{ff18}\u{ff14}${STOP}\u{ff12}\u{ff11}\u{ff16}${STOP}\u{ff13}\u{ff14}/x`,
  'https://\u{ff19}\u{ff13}\u{ff0e}\u{ff11}\u{ff18}\u{ff14}\u{ff0e}\u{ff12}\u{ff11}\u{ff16}\u{ff0e}\u{ff13}\u{ff14}',
  'https://\u{ff19}\u{ff13}\u{ff61}\u{ff11}\u{ff18}\u{ff14}\u{ff61}\u{ff12}\u{ff11}\u{ff16}\u{ff61}\u{ff13}\u{ff14}',
  // invisible characters in a number, and in the ending
  'https://\u{200b}1572395042/x',
  'https://\u{ad}1572395042',
  'https://\u{34f}0x5db8d822',
  `https://${EVIL}${STOP}c\u{34f}om`,
  `https://${EVIL}${STOP}c\u{ad}om`,
  `https://${EVIL}${STOP}c\u{fe0f}om`,
  `https://${EVIL}${STOP}c\u{200b}om`,
  // endings that are written in another script
  `https://${EVIL}${STOP}\u{30b3}\u{30e0}`,
  `https://${EVIL}${STOP}\u{440}\u{444}`,
  `https://${EVIL}${STOP}\u{307f}\u{3093}\u{306a}`,
  // a stop, a percent-encoded dot, or a mark of punctuation first
  `https://\u{2605}${STOP}com`,
  'https://\u{300c}evil%2ecom',
  `https://\u{300c}evil${STOP}\u{ff43}\u{ff4f}\u{ff4d}`,
  `https://\u{300c}ev${STOP}il.com`,
  `https://\u{300c}evil${STOP}com${BACKSLASH}x`,
  // a mark of punctuation inside a host of a zone with a subdomain: the zone may hold any label
  'https://\u{2605}\u{ff0c}a.evil.com',
  // an invisible character that the parser refuses (a joiner outside the script that needs one, a tag
  // character, a mark of direction) and a client that drops it does not
  `https://\u{200d}evil${STOP}com`,
  'https://\u{200d}evil.com',
  'https://\u{200d}evil.com/x',
  'https://\u{24d4}\u{200d}\u{24e5}\u{24d8}\u{24db}.com',
  `https://\u{24d4}\u{24e5}\u{200d}\u{24d8}\u{24db}${STOP}${COM}`,
  'https://\u{1F468}\u{200d}\u{1F469}\u{200d}\u{1F467}.ws/x',
  'https://\u{1F468}\u{200d}\u{1F469}\u{200d}\u{1F467}.ws',
  'https://\u{1F3F4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}.ws/x',
  `https://\u{e0041}evil${STOP}com`,
  'https://\u{202e}evil.com/x',
  'https://\u{200e}evil.com/x',
  `https://\u{3164}evil${STOP}com`,
  `https://\u{ffa0}evil${STOP}com`,
  `https://\u{17b4}evil${STOP}com`,
  // the characters that the parser reads as nothing, first and inside a name, and emoji in their many forms
  `https://\u{2060}evil${STOP}com`,
  `https://\u{feff}evil${STOP}com`,
  `https://\u{ad}evil${STOP}com`,
  `https://\u{34f}evil${STOP}com`,
  `https://\u{fe0f}evil${STOP}com`,
  `https://\u{180b}evil${STOP}com`,
  'https://\u{1F1F9}\u{1F1FC}.ws/x',
  'https://\u{2764}\u{fe0f}.ws/x',
  'https://\u{1F44D}\u{1F3FD}.ws/x',
  // the ending is the name of a top-level domain written in other letters of the root zone
  'https://\u{2605}\u{9818}\u{734e}.\u{53f0}\u{7063}/x',
  `https://${EVIL}${STOP}\u{7db2}\u{7ad9}`,
  `https://${EVIL}${STOP}\u{d55c}\u{ad6d}`,
  `https://${EVIL}${STOP}xn--p1ai`,
  `https://\u{9019}\u{662f}\u{9818}\u{734e}${STOP}xn--rut30ppp6a97d`,
]);

const TEXT = Object.freeze([
  // the parser gives one label (a backslash ends the host; a mark that is no dot; a number behind a mark;
  // a dot at the end of the host; a port with nothing in front of it)
  [`https://\u{300c}evil${BACKSLASH}.com`, 'a backslash ends the host'],
  [`https://${EVIL}\u{ff65}com`, 'the halfwidth middle dot is no dot'],
  ['https://\u{300c}2130706433', 'a number behind a mark is no number'],
  [`https://\u{300c}evil${STOP}/x`, 'one label, and the dot at its end'],
  [`https://${EVIL}${STOP}/x`, 'one label, and the dot at its end'],
  [`https://${EVIL}:8080/x`, 'one label and a port'],
  // the parser refuses the run
  [`https://${EVIL}\u{2024}com/claim`, 'the one dot leader is refused'],
  [`https://${EVIL}\u{fe52}com/claim`, 'the small full stop is refused'],
  [`https://${EVIL}\u{2488}com`, 'the digit one full stop is refused'],
  [`https://${EVIL}\u{2025}com`, 'the two dot leader is refused'],
  ['https://\u{301}evil.com', 'a label may not begin with a combining mark'],
  [`https://\u{301}evil${STOP}com`, 'a label may not begin with a combining mark, and no client drops one'],
  ['https://\u{ff3b}::1\u{ff3d}/x', 'full-width brackets are no IPv6 address'],
  // an ASCII quote first is no host a name server has (the host is "evil.com, and no label begins with a quote)
  [`https://"${EVIL}.com`, 'a quote first: the plain URL step reads no host there, and no registry has one'],
  // sentences about "https://": no host, a refused run, or a last label that is no ending
  ['只要看到https://就代表有加密', 'no dot'],
  ['以https://為開頭的網址比較安全。', 'no dot'],
  ['把http://改成https://就好了', 'no dot'],
  ['你設定的網址要加上https://前綴', 'no dot'],
  ['在網址列輸入https://後面接網域', 'no dot'],
  ['瀏覽器顯示https://表示憑證有效', 'no dot'],
  ['API 要求使用https://協定傳輸資料', 'no dot'],
  ['結尾不用斜線，開頭要https://就好', 'no dot'],
  ['註冊頁面的https://鎖頭是綠色的', 'no dot'],
  ['怎麼讓我的網站支援https://？', 'no dot'],
  ['請以https://開頭輸入，例如「官網」', 'no dot'],
  ['我只記得https://後面有個google', 'no dot'],
  ['網址開頭都是https://、不是ftp://', 'no dot'],
  ['你說的https://是什麼意思？', 'no dot'],
  ['小吉只會放行https://開頭的官方連結', 'no dot'],
  ['請改用 https://。', 'a stop with no label in front of it'],
  ['網址一定要以https://開頭，不然瀏覽器會警告', 'no dot'],
  ['請確認連結是https://開頭的再點', 'no dot'],
  ['https://是加密連線，http://不是', 'no dot'],
  ['https://和http://差在哪裡？', 'no dot'],
  ['「https://」這個前綴代表安全連線', 'no dot'],
  ['所有外部連結都必須是https://（不能是http://）', 'no dot'],
  ['網址開頭是https://。記得加', 'no host in front of the stop'],
  ['要用https://：否則會被擋', 'the parser refuses the colon'],
  ['網站從http://升級到https://了嗎？', 'no dot'],
  ['https://後面不能有空格，要直接接網域', 'no dot'],
  ['日本語：https://で始まるアドレス', 'no dot'],
  ['한국어：https://로 시작해요', 'no dot'],
  ['https://→安全；http://→不安全', 'no dot'],
  ['請用https://……之類的格式', 'no dot'],
  ['https://【網域】/【路徑】', 'no dot'],
  ['格式：https://網域/路徑', 'a dot in the path is no dot of the host'],
  ['要用https://開頭，版本v1.1.2以後都支援', 'cut at the comma, and the last label mixes a digit and Chinese'],
  ['https://開頭的比例是99.5%', 'the "%" is refused by the parser'],
  ['請在設定裡填https://開頭的網址，存到config.json', 'cut at the comma'],
  ['以https://開頭，下午3.30開會', 'cut at the comma'],
  ['要用https://開頭.不要用http', 'the last label mixes Chinese and ASCII letters'],
  ['網址以https://開頭．不用www', 'the last label mixes Chinese and ASCII letters'],
  ['https://開頭。123也可以', 'the last label mixes a digit and Chinese'],
  ['https://開頭。 Use HTTPS', 'a space follows the stop: no label behind it'],
  ['https://開頭/index.html', 'a dot in the path is no dot of the host'],
  ['https://開頭?x=a.b', 'a dot in the query is no dot of the host'],
  // a last label that is a sentence, or a word, is no ending: only the names of top-level domains are
  ['https://開頭。這是常識', 'the last label is a sentence'],
  ['https://開頭。記住了嗎', 'the last label is a sentence'],
  ['請輸入以https://開頭的網址。請注意大小寫', 'the last label is a sentence'],
  ['https://是加密的。http://不是。所以要用前者。', 'the next scheme ends the run, and the last labels are sentences'],
  ['記得用https://。不然會被擋。', 'no host in front of the stop'],
  ['以https://開頭。', 'a stop at the end'],
  ['以https://開頭。 下一句', 'a space follows the stop: no label behind it'],
  ['以https://開頭；這樣安全。', 'cut at the semicolon'],
  // paragraphs of several sentences, written without a space, with "https://" in the first or in a later one
  // (they are one run up to the next space, and each full stop in it is a dot to the parser)
  ['請記得網址要以https://開頭。這樣比較安全，也比較不會被釣魚網站騙。另外記得檢查網域。', 'a paragraph: its last label is a sentence'],
  ['網址以https://開頭。你可以放心使用。', 'a paragraph: its last label is a sentence'],
  ['小吉只放行https://開頭的官方連結。其他的都會被移除。謝謝配合。', 'a paragraph: its last label is a sentence'],
  ['請用https://開頭的網址。謝謝！', 'a paragraph: its last label is a sentence'],
  ['以https://開頭，這樣安全。下一句。', 'a paragraph: its last label is a sentence'],
  ['網站網址一定要以https://開頭。這代表連線有加密，資料比較安全。如果看到http://就要小心。記得先確認網域名稱是否正確。', 'a paragraph'],
  ['請把設定檔裡的網址改成https://開頭的版本。舊版的http://網址已經不能用了。修改完成後請重新啟動服務，然後再測試一次。', 'a paragraph'],
  ['小吉提醒大家：只有https://開頭的官方連結才安全！其他來源的連結請不要隨便點。如果不確定，請先詢問管理員。', 'a paragraph'],
  ['開發文件寫得很清楚：API 位址必須使用https://協定。端點路徑從/v1開始，回傳格式是JSON。', 'a paragraph'],
  ['今天學到一件事：瀏覽器網址列的https://不是裝飾，它代表傳輸有加密。鎖頭圖示則代表憑證有效。兩者要一起看。', 'a paragraph'],
  ['請先到設定頁面，把伺服器位址填成https://開頭的網址，再按下儲存。儲存成功後會看到綠色提示，失敗的話請檢查網路。', 'a paragraph'],
  ['很多釣魚網站會假裝成官方網站，網址卻不是https://開頭。看到可疑連結先別點，截圖給管理員確認。平安最重要。', 'a paragraph'],
  ['新手常問：為什麼我的網站是http://而不是https://？答案是還沒申請憑證。申請完成並設定好之後，就會自動變成https://了。', 'a paragraph'],
  ['這份教學會示範如何用Node.js寫一個簡單的伺服器，監聽https://開頭的請求。程式碼約三十行。需要的套件只有一個，安裝指令寫在最後。', 'a paragraph'],
  ['我們的客服時間是週一到週五上午九點到下午六點。如果要查詢訂單，請提供https://開頭的訂單頁面網址。收到後會在一個工作天內回覆。', 'a paragraph'],
  ['記得檢查：一、網址是否以https://開頭；二、網域名稱有沒有拼錯；三、頁面有沒有要求輸入密碼。三項都沒問題才可以繼續。', 'a paragraph'],
  ['公告：本站即日起全面改用https://連線。舊的書籤請更新。造成不便，敬請見諒。', 'a paragraph'],
  ['Q：為什麼點了連結會跳出警告？A：因為網址開頭不是https://，瀏覽器判斷不安全。你可以先關閉頁面。', 'a paragraph'],
  ['教學：把網址貼進瀏覽器，若前面沒有https://，請自己補上。補完按Enter。成功後就會進入首頁。', 'a paragraph'],
  ['提醒：請勿在不明的https://網站輸入帳號密碼。官方不會私訊要你點連結。收到可疑訊息請直接封鎖。', 'a paragraph'],
  ['他說這個網站的加密做得不錯，網址是https://開頭，憑證也沒過期。不過內容有點無聊。', 'a paragraph'],
  ['活動辦法如下：第一，用https://開頭的網址報名。第二，填寫姓名與電話。第三，等待通知。名額有限，額滿為止。', 'a paragraph'],
  ['機器人設定教學。步驟一，到開發者頁面複製憑證。步驟二，貼到設定檔。回呼網址要用https://開頭。', 'a paragraph'],
  ['測試結果：連線速度提升約百分之二十。https://比http://快是因為HTTP/2。這個說法不完全正確。', 'a paragraph'],
  ['筆記：公司網站改版後，所有連結都要用https://開頭。舊文章裡的連結也要一併修正。預計下週三完成。', 'a paragraph'],
  ['先寫結論：我們選擇https://作為預設。原因有三，第一是安全，第二是相容，第三是搜尋排名。細節如下。', 'a paragraph'],
  ['朋友問我為什麼要花錢買憑證。我說https://不只是一個符號。它背後是一整套信任機制。聽完他就懂了。', 'a paragraph'],
  ['週報：本週完成了登入頁改版、改用https://傳輸、修正兩個錯誤。下週預計處理效能問題，還有文件整理。', 'a paragraph'],
  ['注意！輸入網址時別漏掉https://。少了它有些瀏覽器會自動補，有些不會。為了保險請自己打完整。', 'a paragraph'],
]);

const TEXT_WITH_A_NAME = Object.freeze([
  ['https://後接「discord.gg」是邀請', 'https://後接「[連結已移除]」是邀請'],
  ['https://後面接網域，例如google.com', 'https://後面接網域，例如[連結已移除]'],
  ['網址要以https://開頭，像是example.com這樣', '網址要以https://開頭，像是[連結已移除]這樣'],
  ['https://開頭的網址，比如 example.com', 'https://開頭的網址，比如 [連結已移除]'],
  ['https://開頭。然後接 example.com', 'https://開頭。然後接 [連結已移除]'],
]);

// An address with what stands around it, which stays: [input, expected]. The invisible and no-break characters
// first are the cases of a character the step for schemes does not read as a part of the host.
const WITH_CONTEXT = Object.freeze([
  ['**https://\u{1F381}.ws/x**', '**[連結已移除]**'],
  ['||https://\u{1F381}.ws/x||', '||[連結已移除]||'],
  ['(https://\u{1F381}.ws/x)', '([連結已移除])'],
  ['\u{300c}https://\u{1F381}.ws/x\u{300d}', '\u{300c}[連結已移除]\u{300d}'],
  ['HTTPS://\u{1F381}.ws/x', '[連結已移除]'],
  ['https://\u{2605} https://\u{1F381}.ws/x', 'https://\u{2605} [連結已移除]'],
  ['https://discord.gg/TqkCx9kYmk\u{ff0c}https://\u{1F381}.ws/x', 'https://discord.gg/TqkCx9kYmk\u{ff0c}[連結已移除]'],
  ['https://\u{200b}evil.com', '[連結已移除]'],
  ['https://\u{feff}evil.com/x', '[連結已移除]'],
  ['https://\u{180e}evil.com', '[連結已移除]'],
  // white space ends the link before it begins: the name behind it is a name of its own
  ['https://\u{a0}evil.com', 'https://\u{a0}[連結已移除]'],
  ['https://\u{3000}evil.com', 'https://\u{3000}[連結已移除]'],
  // the parser refuses a Hebrew letter in front of Latin letters in one label (the rule of direction), and
  // no client of an older kind reads it either: the name step finds the name behind the scheme, and the
  // scheme goes with it
  ['https://\u{5d0}evil.com/x', '[連結已移除]'],
  ['https://\u{301}evil.com/x', '[連結已移除]'],
  // a zero width joiner is refused by the parser, and dropped by a client of an older kind: all of it goes
  ['https://\u{200d}evil.com', '[連結已移除]'],
  ['請看https://\u{200d}evil\u{3002}com\u{ff0c}謝謝', '請看[連結已移除]\u{ff0c}謝謝'],
]);

const REMOVED_BY_DESIGN = Object.freeze([
  ['以https://開頭。OK？', '以[連結已移除]？'],
  ['網址以https://開頭。TW 的網站也是', '網址以[連結已移除] 的網站也是'],
  ['正確的寫法是https://開頭。Use HTTPS always', '正確的寫法是[連結已移除] HTTPS always'],
  ['要用https://開頭.OK', '要用[連結已移除]'],
  // a last label that is the name of a top-level domain is a host for the parser as well
  ['請看https://開頭。公司', '請看[連結已移除]'],
  ['https://開頭的說明。世界', '[連結已移除]'],
  ['請輸入https://開頭的網址。台灣', '請輸入[連結已移除]'],
  ['https://（例如a.com）', '[連結已移除]）'],
  ['請寫成https://「網域」.com', '請寫成[連結已移除]'],
  ['寫 https://你的網域.tw/ 就可以', '寫 [連結已移除] 就可以'],
]);

module.exports = Object.freeze({ ADDRESSES, TEXT, TEXT_WITH_A_NAME, WITH_CONTEXT, REMOVED_BY_DESIGN });
