const assert = require('assert');
const { cleanJson, extractText } = require('../lib/openai-pdf-extractor');

assert.deepEqual(cleanJson('```json\n{"ok":true}\n```'), {ok:true});
assert.deepEqual(cleanJson('resultado: [{"valor":10}]'), [{valor:10}]);
assert.equal(extractText({output:[{content:[{type:'output_text',text:'{"a":1}'}]}]}), '{"a":1}');
console.log('openai-pdf-extractor.test.js: OK');
