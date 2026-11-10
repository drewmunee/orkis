// Moderation: usernames may not contain racial slurs (ordinary swearing is fine), and swear words in
// chat feed the swear jar.
//
// The slur lists are base64-encoded so the words don't sit in the source in plain text. To review or
// edit them: Buffer.from(SLURS_ANYWHERE, 'base64').toString() (comma-separated). "Anywhere" words are
// blocked even inside other letters; "whole word" ones are short enough to appear inside normal words
// (e.g. inside "spicy" or "raccoon"), so they only count as a whole word.
const decode = s => Buffer.from(s, 'base64').toString().split(',');
const SLURS_ANYWHERE = 'bmlnZ2VyLG5pZ2dhLG5pZ2xldCx3ZXRiYWNrLGJlYW5lcixyYWdoZWFkLHRvd2VsaGVhZCxqaWdhYm9vLHBvcmNobW9ua2V5LGp1bmdsZWJ1bm55LHppcHBlcmhlYWQsZGFya2llLGNoaW5hbWFuLGhhbGZicmVlZCxyZWRza2luLHNwZWFyY2h1Y2tlcix0YXJiYWJ5LGNvb25hc3MsbmVncm9pZA==';
const SLURS_WHOLE_WORD = 'bmlnLG5pZ2dheixjaGluayxnb29rLHNwaWMsc3BpY2ssa2lrZSxjb29uLHBha2ksamFwLHdvcCxkYWdvLGtyYXV0LGluanVuLHNxdWF3LGhvbmt5LGd5cHBvLHlpZCxneXBv';

// lower-case and undo common look-alike characters ("n1gg3r" -> "nigger")
const LEET = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g' };
const normalize = s => String(s).toLowerCase().replace(/[01!|3@4$57+89]/g, c => LEET[c]);
// each listed word becomes a pattern that also catches stretched letters ("niiiigger"), without
// loosening it: a double letter in the word still needs at least two (so "Niger" stays allowed)
const stretchy = w => w.replace(/(.)\1*/g, run => `${run[0]}{${run.length},}`);
const anywhere = decode(SLURS_ANYWHERE).map(w => new RegExp(stretchy(w)));
const wholeWord = decode(SLURS_WHOLE_WORD).map(w => new RegExp(`^${stretchy(w)}$`));
// real words that happen to contain a listed word
const ALLOWED_WORDS = /snigger|sniggering/g;

// true if a username is OK to use
function nameAllowed(name) {
  const n = normalize(name);
  const squashed = n.replace(/[^a-z]/g, '').replace(ALLOWED_WORDS, ''); // "n_i g.g-e r" -> "nigger"
  if (anywhere.some(re => re.test(squashed))) return false;
  return !n.split(/[^a-z]+/).some(t => wholeWord.some(re => re.test(t)));
}
const NAME_REFUSED = "That username isn't allowed. Please pick a different one.";

// Swear words for the swear jar. Stems match the start of a word ("fucking", "shitty"); short ones only
// count on their own ("ass" but not "class").
const SWEAR_STEMS = ['fuck', 'fuk', 'fck', 'shit', 'bitch', 'bastard', 'damn', 'dammit', 'piss', 'asshole', 'cunt', 'motherf', 'bollock', 'bullshit', 'goddamn', 'jackass', 'dumbass', 'dipshit', 'wanker', 'twat', 'prick'];
const SWEAR_WORDS = new Set(['ass', 'arse', 'hell', 'crap', 'dick', 'dicks', 'cock', 'cocks', 'wtf', 'stfu', 'ffs', 'asses', 'bloody', 'bugger', 'fu']);
// true if a chat message contains at least one swear word
function hasSwear(text) {
  const words = String(text).toLowerCase().replace(/[@$5013!]/g, c => ({ '@': 'a', '$': 's', '5': 's', '0': 'o', '1': 'i', '3': 'e', '!': 'i' }[c])).split(/[^a-z*]+/);
  return words.some(w => w && (SWEAR_WORDS.has(w) || SWEAR_STEMS.some(s => w.startsWith(s) || (s.length >= 4 && w.includes(s))) || /^f\*+k|^s\*+t$|^f\*+/.test(w)));
}

module.exports = { nameAllowed, NAME_REFUSED, hasSwear };
