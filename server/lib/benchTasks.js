// The "real work" benchmark's tasks (services/localPerf.js): 24 short, everyday prompts of every kind (explain, write,
// code, rewrite, translate), and 2 answers to a long conversation. Fixed, so two runs compare.

const SHORT = [
  'Explain in three sentences why the sky is blue.',
  'What is the difference between a process and a thread? Keep it short.',
  'Write a haiku about a cup of coffee going cold.',
  'Give me five names for a small bakery that sells sourdough bread.',
  'Write a JavaScript function that returns the largest number in an array without using Math.max.',
  'What does the HTTP status code 418 mean, and where does it come from?',
  'Rewrite this sentence so it is shorter and clearer: "Due to the fact that the meeting has been moved, we are going to need to reschedule the call that we had planned for the afternoon."',
  'Translate into French: "The train leaves at eight, so we should meet at the station at half past seven."',
  'Translate into Spanish: "Could you send me the report before Friday? I would like to read it over the weekend."',
  'Translate into German: "Thank you for your help yesterday. Everything works now."',
  'Translate into Japanese: "I will be ten minutes late. Please start without me."',
  'A shop sells pens at 3 for $2. How much do 12 pens cost? Show the steps.',
  'Write a short, friendly email declining an invitation to a party next Saturday.',
  'List four ways to make a slow website load faster, one line each.',
  'What is a regular expression that matches a date written as YYYY-MM-DD? Explain each part.',
  'Summarize the plot of Romeo and Juliet in two sentences.',
  'Write a SQL query that lists the ten customers who spent the most, from a table orders(customer_id, amount).',
  'Explain what a git rebase does, as if to someone who only knows git commit and git push.',
  'Suggest three simple dinners that need less than 20 minutes and only one pan.',
  'What are the main differences between TCP and UDP? Answer in a short table.',
  'Write a Python function that checks whether a string is a palindrome, ignoring spaces and case.',
  'Give me a short checklist for packing for a three day hiking trip.',
  'Explain the difference between "affect" and "effect" with one example of each.',
  'Write a limerick about a cat that learns to use a keyboard.',
];

// A long conversation, about 3,000 tokens; the assistant answers the last message.
const CONVO = [
  ['user', 'Hi! I just moved into a house with a small backyard, about 6 by 8 meters, and I would like to start a vegetable garden this spring. I have never grown anything except a few houseplants. Where do I even start?'],
  ['assistant', 'Congratulations on the new house! A 6 by 8 meter yard is a great size for a first garden. Start with three things: find where the sun falls, check the soil, and decide what you actually like to eat. Most vegetables need at least six hours of direct sun a day, so spend a day noting which parts of the yard get light in the morning, at noon and in the afternoon.'],
  ['user', 'I watched it on Sunday. The back half gets sun from about 9 until 4, the front half near the house is in shade until noon. The soil looks quite hard and has a lot of clay in it.'],
  ['assistant', 'Then the back half is your garden. Seven hours of sun is plenty for tomatoes, beans, squash and herbs. The shady front can still grow lettuce, spinach and parsley, which like a little shade in summer. Clay soil holds water and nutrients well, but it drains slowly and gets hard. The easiest fix for a beginner is raised beds filled with a mix of topsoil and compost, so you do not have to dig the clay at all.'],
  ['user', 'Raised beds sound good. How big should they be, and how many would fit?'],
  ['assistant', 'Make each bed no wider than 1.2 meters, so you can reach the middle from both sides without stepping on the soil. A length of 2.4 meters is a good size and uses standard boards. In the sunny back half, which is about 6 by 4 meters, you could fit three beds of 1.2 by 2.4 meters with paths of 60 centimeters between them. That gives you almost 9 square meters of growing space, which is a lot for a first year.'],
  ['user', 'What should I build them from? I saw some made of treated wood at the store, but I am not sure that is safe for food.'],
  ['assistant', 'Modern pressure treated wood in most countries no longer uses arsenic, and it is generally considered safe for vegetable beds, but many gardeners still prefer untreated cedar or larch, which resist rot naturally and last eight to ten years. Galvanized steel beds are another option: they last a long time and warm up quickly in spring. Avoid old railway sleepers, which are often soaked in creosote.'],
  ['user', 'I think I will go with larch. How deep should the beds be, and how much soil will I need?'],
  ['assistant', 'A depth of 30 centimeters is enough for almost every vegetable, since the roots can also grow down into the loosened ground below. One bed of 1.2 by 2.4 meters at 30 centimeters deep holds about 0.86 cubic meters, so three beds need about 2.6 cubic meters. Buying that in bags is expensive, so ask a local garden center about a bulk delivery of a vegetable mix, which is usually about 60 percent topsoil and 40 percent compost.'],
  ['user', 'That is more soil than I expected! Now the fun part: what should I plant in the first year?'],
  ['assistant', 'Pick a few easy crops that you love to eat. Good choices for beginners are cherry tomatoes, bush beans, zucchini, lettuce, radishes, and herbs like basil and chives. Zucchini is very productive, so one or two plants are plenty. Cherry tomatoes are more forgiving than large tomatoes and ripen earlier. Radishes are ready in about four weeks, which is great for seeing quick results.'],
  ['user', 'We eat a lot of tomatoes and salad. My partner also wants to try peppers. Can all of that fit?'],
  ['assistant', 'Easily. One idea: bed one for tomatoes and peppers, about four tomato plants along the back and four pepper plants in front; bed two for beans and zucchini; bed three for salad, radishes and herbs, sown in short rows every two weeks so you do not get everything at once. Put the tomato bed on the north side so the tall plants do not shade the others.'],
  ['user', 'Should I start from seeds or buy small plants?'],
  ['assistant', 'Both. Tomatoes and peppers need a long season, so for a first year it is easiest to buy small plants from a nursery in late spring. Beans, zucchini, lettuce and radishes grow quickly and are easy to sow directly into the bed. Herbs like basil can go either way; chives are easiest as a small plant, since they come back every year.'],
  ['user', 'When should I plant everything? Our last frost is usually around the middle of April.'],
  ['assistant', 'With a last frost in mid April: sow radishes, lettuce and spinach from late March, since they handle cold well. Plant tomatoes, peppers and basil outside in early May, once the nights stay above 10 degrees. Sow beans and zucchini directly in early to mid May, when the soil has warmed. Keep a light cloth nearby in case a late cold night is forecast.'],
  ['user', 'And watering? I work from home three days a week but travel sometimes.'],
  ['assistant', 'Raised beds dry out faster than the ground, so in summer they may need water every day or two. Water deeply in the morning, at the base of the plants rather than on the leaves. Since you travel, a simple drip line or soaker hose on a battery timer is worth the money: it costs little, saves a lot of water, and keeps the plants alive while you are away. A layer of straw mulch also keeps the soil moist for longer.'],
  ['user', 'This is really helpful. A few last questions before I start buying things. First, what tools do I actually need, as a beginner on a budget? Second, are there any pests I should watch out for with tomatoes and lettuce? Third, should I put anything at the bottom of the beds before adding the soil, like cardboard or stones? And last, is there anything I can grow along the fence on the shady side, so that part of the yard is not wasted?'],
];
const SYSTEM = 'You are a helpful assistant. Answer clearly and practically, and answer every question asked.';

// Every task: { id, group, label, messages, maxTokens }. group: "translate" (the short prompts; the name is kept so earlier
// runs still line up) or "write" (the long conversation).
export function benchTasks() {
  const tasks = SHORT.map((text, i) => ({
    id: `short-${i + 1}`, group: 'translate', label: 'Short prompt',
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }], maxTokens: 512,
  }));
  const convo = CONVO.map(([role, content]) => ({ role, content }));
  tasks.push({ id: 'reply', group: 'write', label: 'Reply to a long conversation', messages: [{ role: 'system', content: SYSTEM }, ...convo], maxTokens: 600 });
  tasks.push({ id: 'summary', group: 'write', label: 'Summarize a long conversation', messages: [{ role: 'system', content: SYSTEM }, ...convo,
    { role: 'assistant', content: 'Before I answer, would a summary of the plan so far help?' },
    { role: 'user', content: 'Yes please: summarize everything we decided so far as a short checklist, in order of when I should do it.' }], maxTokens: 600 });
  return tasks;
}
