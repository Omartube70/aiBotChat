/**
 * يُستورَد أول حاجة في نقاط التشغيل المحلية (Node) فقط.
 * بيقرأ ملف .env ويحقن القيم في config.
 * Workers مابيستوردش الملف ده إطلاقاً.
 */
import 'dotenv/config';
import { applyEnv } from './config.js';

applyEnv(process.env);
