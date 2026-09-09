/**
 * تجربة البوت من الترمينال بدون واتساب.
 * التشغيل:  npm run chat
 * اكتب رسالتك واضغط Enter. اكتب "خروج" للإنهاء.
 */
import '../src/load-env.js';
import readline from 'node:readline';
import { generateReply } from '../src/gemini.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let history = [];
let closed = false;
rl.on('close', () => {
  closed = true;
});

console.log('🤖 بوت القدس لمهمات المصاعد — وضع التجربة');
console.log('   اكتب سؤالك عن أي منتج. "خروج" للإنهاء، "/reset" لمسح المحادثة.\n');

function ask() {
  if (closed) return;
  rl.question('أنت: ', async (line) => {
    const text = line.trim();
    if (closed) return;
    if (!text) return ask();
    if (['خروج', 'exit', 'quit'].includes(text.toLowerCase())) {
      rl.close();
      return;
    }
    if (text === '/reset') {
      history = [];
      console.log('— اتمسحت المحادثة —\n');
      return ask();
    }
    try {
      const out = await generateReply(text, history);
      history = out.history;
      console.log(`\nالبوت: ${out.reply}\n`);
    } catch (err) {
      console.error('\n[خطأ]', err.message, '\n');
    }
    ask();
  });
}

ask();
