const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function sendMainMenu(ctx, chatId) {
    await supabase.from('exam_users').upsert({ chat_id: chatId, current_step: 'MAIN_MENU' });
    const intro = `🎓 *বিশ্ববিদ্যালয় ভর্তি প্রস্তুতি বটে স্বাগতম!*\n\n`
                + `আপনার দুর্বল বিষয়গুলোকে শক্তিশালী করতে আমি তৈরি।\n`
                + `🔹 আনলিমিটেড স্মার্ট প্রশ্ন\n🔹 ভুল উত্তরের বাংলা লেকচার\n🔹 লাইভ পরীক্ষা\n\n`
                + `👉 *কী করতে চান তা সিলেক্ট করুন:*`;
    
    return ctx.replyWithMarkdown(intro, Markup.inlineKeyboard([
        [Markup.button.callback('📖 সাধারণ অনুশীলন', 'practice_mode')],
        [Markup.button.callback('⏱️ লাইভ পরীক্ষা (Exam)', 'exam_mode_select')],
        [Markup.button.callback('📁 আমার রিভিশন ফোল্ডার', 'revision_folder')]
    ]));
}

bot.command('start', async (ctx) => sendMainMenu(ctx, ctx.chat.id));
bot.action('main_menu', async (ctx) => {
    ctx.answerCbQuery().catch(()=>{});
    return sendMainMenu(ctx, ctx.chat.id);
});

bot.action('practice_mode', async (ctx) => {
    ctx.answerCbQuery().catch(()=>{});
    return ctx.reply('📚 *কোন বিষয়টি অনুশীলন করতে চান?*', Markup.inlineKeyboard([
        [Markup.button.callback('🇬🇧 English Grammar', 'subj_english')],
        [Markup.button.callback('🌍 সাধারণ জ্ঞান (GK)', 'subj_gk')],
        [Markup.button.callback('🇧🇩 বাংলা', 'subj_bangla')]
    ]));
});

bot.action(/^subj_/, async (ctx) => {
    const subjectRaw = ctx.callbackQuery.data.replace('subj_', '');
    let subjectName = ''; let topics = [];
    if (subjectRaw === 'english') {
        subjectName = 'English Grammar';
        topics = ['Preposition', 'Right form of Verbs', 'Voice Change', 'Subject-Verb Agreement'];
    } else if (subjectRaw === 'gk') {
        subjectName = 'সাধারণ জ্ঞান';
        topics = ['মুক্তিযুদ্ধ ও ইতিহাস', 'বাংলাদেশ বিষয়াবলি', 'আন্তর্জাতিক বিষয়াবলি'];
    } else if (subjectRaw === 'bangla') {
        subjectName = 'বাংলা';
        topics = ['সন্ধি ও সমাস', 'কারক ও বিভক্তি', 'শুদ্ধ-অশুদ্ধ'];
    }
    await supabase.from('exam_users').update({ selected_subject: subjectName }).eq('chat_id', ctx.chat.id);
    const buttons = topics.map(t => [Markup.button.callback(t, `topic_${t}`)]);
    ctx.answerCbQuery().catch(()=>{});
    return ctx.reply(`আপনি ${subjectName} সিলেক্ট করেছেন।\n👉 *এখন একটি টপিক বেছে নিন:*`, Markup.inlineKeyboard(buttons));
});

bot.action(/^topic_/, async (ctx) => {
    ctx.answerCbQuery('প্রশ্ন তৈরি হচ্ছে...').catch(()=>{});
    const topic = ctx.callbackQuery.data.replace('topic_', '');
    await supabase.from('exam_users').update({ selected_topic: topic }).eq('chat_id', ctx.chat.id);
    await generateAndSendQuestion(ctx, ctx.chat.id, topic, false);
});

bot.action('next_question', async (ctx) => {
    ctx.answerCbQuery('নতুন প্রশ্ন...').catch(()=>{});
    const { data: user } = await supabase.from('exam_users').select('selected_topic').eq('chat_id', ctx.chat.id).single();
    await generateAndSendQuestion(ctx, ctx.chat.id, user.selected_topic, false);
});

bot.action('exam_mode_select', async (ctx) => {
    ctx.answerCbQuery().catch(()=>{});
    return ctx.reply('⏱️ *লাইভ পরীক্ষা (Exam Mode)*\n\nকোন বিষয়ের উপর ৫ মার্কের পরীক্ষা দিতে চান?', Markup.inlineKeyboard([
        [Markup.button.callback('🇬🇧 English Grammar', 'exam_english')],
        [Markup.button.callback('🌍 সাধারণ জ্ঞান (GK)', 'exam_gk')],
        [Markup.button.callback('🇧🇩 বাংলা', 'exam_bangla')],
        [Markup.button.callback('🏠 মেইন মেনু', 'main_menu')]
    ]));
});

bot.action(/^exam_/, async (ctx) => {
    ctx.answerCbQuery('পরীক্ষা শুরু হচ্ছে...').catch(()=>{});
    const subjRaw = ctx.callbackQuery.data.replace('exam_', '');
    let subjectName = (subjRaw === 'english') ? 'English Grammar' : (subjRaw === 'gk') ? 'সাধারণ জ্ঞান' : 'বাংলা';
    await supabase.from('exam_users').update({ selected_subject: subjectName }).eq('chat_id', ctx.chat.id);
    await ctx.reply(`🚀 *${subjectName}* এর উপর লাইভ পরীক্ষা শুরু হলো!\n(মোট প্রশ্ন: ৫টি)`);
    await generateAndSendQuestion(ctx, ctx.chat.id, subjectName, true, 0, 1);
});

async function generateAndSendQuestion(ctx, chatId, topic, isExam = false, score = 0, qNum = 1) {
    let msg;
    try {
        msg = await ctx.reply('⏳ *নতুন প্রশ্ন তৈরি করা হচ্ছে...*', { parse_mode: 'Markdown' });
        
        // 🔥 এইবার আমি নিজে গ্যারান্টি দিয়ে gemini-pro সেট করে দিয়েছি 🔥
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const prompt = `Act as an expert admission test teacher in Bangladesh. Create a new MCQ on: '${topic}'. Reply ONLY with a raw JSON object exactly like this: {"question": "...", "options": ["A", "B", "C", "D"], "correct_option_index": 0, "explanation": "Provide a brief Bengali explanation"}`;

        const result = await model.generateContent(prompt);
        let rawText = result.response.text();
        
        const startIdx = rawText.indexOf('{');
        const endIdx = rawText.lastIndexOf('}');
        if (startIdx === -1) throw new Error("Invalid AI Response format.");
        
        const qData = JSON.parse(rawText.substring(startIdx, endIdx + 1));
        qData.is_exam = isExam; qData.exam_score = score; qData.exam_q_num = qNum;

        await supabase.from('exam_users').update({ current_question: qData }).eq('chat_id', chatId);
        const buttons = qData.options.map((opt, idx) => [Markup.button.callback(opt, `ans_${idx}`)]);
        if (!isExam) buttons.push([Markup.button.callback('🏠 মেইন মেনু', 'main_menu')]);
        
        if (msg) await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(()=>{});
        return ctx.reply(`${isExam ? `⏱️ *প্রশ্ন ${qNum}/5:*` : `📝 *প্রশ্ন:*`} ${qData.question}`, Markup.inlineKeyboard(buttons));
    } catch (error) {
        if (msg) await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
        return ctx.reply(`❌ সমস্যা: ${error.message}`, Markup.inlineKeyboard([[Markup.button.callback('🔄 আবার চেষ্টা করুন', isExam ? 'main_menu' : `topic_${topic}`)]]));
    }
}

bot.action(/^ans_/, async (ctx) => {
    const selectedIdx = parseInt(ctx.callbackQuery.data.replace('ans_', ''));
    const { data: user } = await supabase.from('exam_users').select('*').eq('chat_id', ctx.chat.id).single();
    const qData = user.current_question;
    if (!qData) return ctx.answerCbQuery('⚠️ মেয়াদ শেষ।');
    const isCorrect = (selectedIdx === qData.correct_option_index);

    if (qData.is_exam) {
        let newScore = isCorrect ? qData.exam_score + 1 : qData.exam_score;
        let nextNum = qData.exam_q_num + 1;
        await ctx.deleteMessage().catch(()=>{});
        if (nextNum > 5) {
            return ctx.reply(`🏆 *পরীক্ষা শেষ!*\n✅ স্কোর: ${newScore}/5\n${newScore >= 3 ? '🎉 পাস!' : '❌ ফেল!'}`, Markup.inlineKeyboard([[Markup.button.callback('🏠 মেইন মেনু', 'main_menu')]]));
        } else {
            return generateAndSendQuestion(ctx, ctx.chat.id, user.selected_subject, true, newScore, nextNum);
        }
    }

    let replyText = isCorrect ? `✅ সঠিক!` : `❌ ভুল! সঠিক উত্তর: *${qData.options[qData.correct_option_index]}*`;
    if (!isCorrect) await supabase.from('revision_vault').insert({ chat_id: ctx.chat.id, subject: user.selected_subject, topic: user.selected_topic, question: qData.question, options: qData.options, correct_option: qData.options[qData.correct_option_index], explanation: qData.explanation });
    
    await supabase.from('exam_users').update({ current_question: null }).eq('chat_id', ctx.chat.id);
    return ctx.replyWithMarkdown(`${replyText}\n\n💡 *ব্যাখ্যা:* ${qData.explanation}`, Markup.inlineKeyboard([[Markup.button.callback('➡️ পরবর্তী প্রশ্ন', 'next_question')], [Markup.button.callback('🏠 মেইন মেনু', 'main_menu')]]));
});

bot.action('revision_folder', async (ctx) => {
    const { data: savedItems } = await supabase.from('revision_vault').select('*').eq('chat_id', ctx.chat.id);
    if (!savedItems || savedItems.length === 0) return ctx.reply('ফোল্ডার ফাঁকা!');
    let text = `📁 রিভিশন ফোল্ডার (${savedItems.length} টি)\n\n`;
    savedItems.slice(-3).reverse().forEach((item, idx) => { text += `*Q:* ${item.question}\n*A:* ${item.correct_option}\n\n`; });
    return ctx.replyWithMarkdown(text, Markup.inlineKeyboard([[Markup.button.callback('🗑️ ক্লিয়ার', 'clear_revision')], [Markup.button.callback('🏠 মেইন মেনু', 'main_menu')]]));
});

bot.action('clear_revision', async (ctx) => {
    await supabase.from('revision_vault').delete().eq('chat_id', ctx.chat.id);
    return ctx.reply('✅ ক্লিয়ার হয়েছে।', Markup.inlineKeyboard([[Markup.button.callback('🏠 মেইন মেনু', 'main_menu')]]));
});

module.exports = async function handler(req, res) {
    if (req.method === 'POST') {
        try { await bot.handleUpdate(req.body); } catch (e) {} finally { res.status(200).send('OK'); }
    } else { res.status(200).send('Running!'); }
};
