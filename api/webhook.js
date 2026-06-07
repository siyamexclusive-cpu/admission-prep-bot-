const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

bot.command('start', async (ctx) => {
    try {
        const chatId = ctx.chat.id;
        await supabase.from('exam_users').upsert({ chat_id: chatId, current_step: 'MAIN_MENU' });

        const intro = `🎓 *বিশ্ববিদ্যালয় ভর্তি প্রস্তুতি বটে স্বাগতম!*\n\n`
                    + `আপনার দুর্বল বিষয়গুলোকে শক্তিশালী করতে আমি তৈরি।\n`
                    + `🔹 আনলিমিটেড স্মার্ট প্রশ্ন\n🔹 ভুল উত্তরের বাংলা লেকচার\n🔹 রিভিশন ফোল্ডার\n\n`
                    + `👉 *কী করতে চান তা সিলেক্ট করুন:*`;
        
        return ctx.replyWithMarkdown(intro, Markup.inlineKeyboard([
            [Markup.button.callback('📖 সাধারণ অনুশীলন', 'practice_mode')],
            [Markup.button.callback('⏱️ লাইভ পরীক্ষা (Test)', 'exam_mode')],
            [Markup.button.callback('📁 আমার রিভিশন ফোল্ডার', 'revision_folder')]
        ]));
    } catch (e) {
        console.error("Start Error:", e);
    }
});

bot.action('practice_mode', async (ctx) => {
    ctx.answerCbQuery();
    await supabase.from('exam_users').update({ current_step: 'SELECTING_SUBJECT' }).eq('chat_id', ctx.chat.id);
    
    return ctx.reply('📚 *কোন বিষয়টি অনুশীলন করতে চান?*', Markup.inlineKeyboard([
        [Markup.button.callback('🇬🇧 English Grammar', 'subj_english')],
        [Markup.button.callback('🌍 সাধারণ জ্ঞান (GK)', 'subj_gk')],
        [Markup.button.callback('🇧🇩 বাংলা', 'subj_bangla')]
    ]));
});

bot.action(/^subj_/, async (ctx) => {
    const subjectRaw = ctx.callbackQuery.data.replace('subj_', '');
    let subjectName = '';
    let topics = [];

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

    await supabase.from('exam_users').update({ 
        current_step: 'SELECTING_TOPIC', 
        selected_subject: subjectName 
    }).eq('chat_id', ctx.chat.id);

    const buttons = topics.map(t => [Markup.button.callback(t, `topic_${t}`)]);
    ctx.answerCbQuery();
    return ctx.reply(`আপনি ${subjectName} সিলেক্ট করেছেন।\n👉 *এখন একটি টপিক বেছে নিন:*`, Markup.inlineKeyboard(buttons));
});

bot.action(/^topic_/, async (ctx) => {
    ctx.answerCbQuery();
    const topic = ctx.callbackQuery.data.replace('topic_', '');
    const chatId = ctx.chat.id;

    await supabase.from('exam_users').update({ 
        selected_topic: topic, 
        current_step: 'PRACTICING' 
    }).eq('chat_id', chatId);

    await generateAndSendQuestion(ctx, chatId, topic);
});

bot.action('next_question', async (ctx) => {
    ctx.answerCbQuery('নতুন প্রশ্ন তৈরি হচ্ছে...');
    const { data: user } = await supabase.from('exam_users').select('selected_topic').eq('chat_id', ctx.chat.id).single();
    await generateAndSendQuestion(ctx, ctx.chat.id, user.selected_topic);
});

async function generateAndSendQuestion(ctx, chatId, topic) {
    let msg;
    try {
        msg = await ctx.reply('⏳ *নতুন প্রশ্ন তৈরি করা হচ্ছে... দয়া করে অপেক্ষা করুন।*', { parse_mode: 'Markdown' });

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `University Admission test-এর স্ট্যান্ডার্ড অনুযায়ী '${topic}' এর উপর একটি সম্পূর্ণ নতুন MCQ প্রশ্ন তৈরি করো। 
        রেসপন্সটি শুধুমাত্র এবং কঠোরভাবে নিচের JSON ফরম্যাটে দেবে, এর বাইরে কোনো অতিরিক্ত লেখা দেবে না:
        {
          "question": "এখানে প্রশ্নটি থাকবে",
          "options": ["অপশন A", "অপশন B", "অপশন C", "অপশন D"],
          "correct_option_index": 1, 
          "explanation": "কেন এটি সঠিক এবং বাকিগুলো ভুল তার একটি চমৎকার বাংলা লেকচার/ব্যাখ্যা"
        }
        দ্রষ্টব্য: correct_option_index 0 থেকে 3 এর মধ্যে হবে।`;

        const result = await model.generateContent(prompt);
        let rawText = result.response.text();

        if (!rawText) throw new Error("Empty response from AI");

        rawText = rawText.trim();
        // JSON পার্স করার জন্য এক্সট্রা সেফটি
        if (rawText.startsWith('```json')) {
            rawText = rawText.replace(/
```json\n?/, '').replace(/```/g, '').trim();
        } else if (rawText.startsWith('```')) {
            rawText = rawText.replace(/
```\n?/, '').replace(/```/g, '').trim();
        }

        const qData = JSON.parse(rawText);

        await supabase.from('exam_users').update({ current_question: qData }).eq('chat_id', chatId);

        const buttons = qData.options.map((opt, idx) => [Markup.button.callback(opt, `ans_${idx}`)]);
        buttons.push([Markup.button.callback('🏠 মেইন মেনু', 'main_menu')]);

        if (msg) await ctx.telegram.deleteMessage(chatId, msg.message_id);
        return ctx.reply(`📝 *প্রশ্ন:* ${qData.question}`, Markup.inlineKeyboard(buttons));

    } catch (error) {
        console.error("AI Error:", error);
        if (msg) await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
        return ctx.reply('❌ প্রশ্ন তৈরি করতে সাময়িক সমস্যা হয়েছে। দয়া করে আবার চেষ্টা করুন।', Markup.inlineKeyboard([
            [Markup.button.callback('🔄 আবার চেষ্টা করুন', `topic_${topic}`)],
            [Markup.button.callback('🏠 মেইন মেনু', 'main_menu')]
        ]));
    }
}

bot.action(/^ans_/, async (ctx) => {
    const selectedIdx = parseInt(ctx.callbackQuery.data.replace('ans_', ''));
    const chatId = ctx.chat.id;

    const { data: user } = await supabase.from('exam_users').select('*').eq('chat_id', chatId).single();
    const qData = user.current_question;

    if (!qData) return ctx.answerCbQuery('⚠️ এই প্রশ্নটির মেয়াদ শেষ। নতুন প্রশ্ন নিন।', { show_alert: true });

    const isCorrect = (selectedIdx === qData.correct_option_index);
    let replyText = '';

    if (isCorrect) {
        replyText = `✅ *সঠিক উত্তর!* চমৎকার হয়েছে।\n\n`;
    } else {
        replyText = `❌ *ভুল উত্তর!* \nসঠিক উত্তরটি হবে: *${qData.options[qData.correct_option_index]}*\n\n`;
        
        await supabase.from('revision_vault').insert({
            chat_id: chatId, subject: user.selected_subject, topic: user.selected_topic,
            question: qData.question, options: qData.options, correct_option: qData.options[qData.correct_option_index],
            explanation: qData.explanation
        });
        replyText += `_⚠️ এই প্রশ্নটি আপনার রিভিশন ফোল্ডারে সেভ করা হয়েছে।_\n\n`;
    }

    replyText += `💡 *ব্যাখ্যা (Lecture):*\n${qData.explanation}`;

    await supabase.from('exam_users').update({ current_question: null }).eq('chat_id', chatId);

    ctx.answerCbQuery();
    return ctx.replyWithMarkdown(replyText, Markup.inlineKeyboard([
        [Markup.button.callback('➡️ পরবর্তী প্রশ্ন', 'next_question')],
        [Markup.button.callback('🏠 মেইন মেনু', 'main_menu')]
    ]));
});

bot.action('revision_folder', async (ctx) => {
    const chatId = ctx.chat.id;
    const { data: savedItems } = await supabase.from('revision_vault').select('*').eq('chat_id', chatId);

    if (!savedItems || savedItems.length === 0) {
        ctx.answerCbQuery();
        return ctx.reply('আপনার রিভিশন ফোল্ডারটি ফাঁকা! আপনি প্র্যাকটিসের সময় ভুল উত্তর দিলে তা এখানে সেভ হবে।');
    }

    ctx.answerCbQuery();
    let text = `📁 *আপনার রিভিশন ফোল্ডার (${savedItems.length} টি প্রশ্ন)*\n\n`;
    
    const recentItems = savedItems.slice(-3).reverse();
    recentItems.forEach((item, idx) => {
        text += `*Q${idx + 1}:* ${item.question}\n*Ans:* ${item.correct_option}\n\n`;
    });

    return ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
        [Markup.button.callback('🗑️ ফোল্ডার ক্লিয়ার করুন', 'clear_revision')],
        [Markup.button.callback('🏠 মেইন মেনু', 'main_menu')]
    ]));
});

bot.action('clear_revision', async (ctx) => {
    await supabase.from('revision_vault').delete().eq('chat_id', ctx.chat.id);
    ctx.answerCbQuery('ফোল্ডার ক্লিয়ার করা হয়েছে!');
    return ctx.reply('✅ আপনার রিভিশন ফোল্ডারের সব প্রশ্ন মুছে ফেলা হয়েছে।');
});

bot.action('main_menu', (ctx) => {
    ctx.answerCbQuery();
    bot.handleUpdate({ message: { text: '/start', chat: { id: ctx.chat.id } } });
});

bot.action('exam_mode', (ctx) => {
    ctx.answerCbQuery();
    ctx.reply('⏱️ লাইভ এক্সাম মোডটি খুব শীঘ্রই চালু হচ্ছে! আপাতত সাধারণ অনুশীলন করুন।');
});

// ----------------- মূল সমাধান (Webhook Handler) -----------------
module.exports = async function handler(req, res) {
    if (req.method === 'POST') {
        try {
            await bot.handleUpdate(req.body);
        } catch (error) {
            console.error("❌ Webhook Error:", error);
        } finally {
            // এই লাইনটিই সেই লুপ ভাঙবে! এরর হলেও টেলিগ্রামকে ২০০ স্ট্যাটাস পাঠাবে।
            res.status(200).send('OK'); 
        }
    } else {
        res.status(200).send('Admission Bot is Running Fine!');
    }
};
