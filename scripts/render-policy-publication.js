const fs = require('node:fs');
const path = require('node:path');
const { publication } = require('../website/policyPublication.js');

const fallbackPattern = /(<(?:p|span)\b[^>]*data-policy-publication[^>]*><noscript>)(.*?)(<\/noscript><\/(?:p|span)>)/gs;

function renderPolicyPublicationFallbacks(policyHtml, publicationMetadata) {
  let fallbackCount = 0;
  const renderedHtml = policyHtml.replace(fallbackPattern, (_match, opening, _oldText, closing) => {
    fallbackCount += 1;
    return `${opening}${publicationMetadata.displayText}${closing}`;
  });
  if (fallbackCount !== 2) throw new Error(`Expected two policy publication fallbacks, found ${fallbackCount}`);
  return renderedHtml;
}

function synchronizePolicyPublicationFallbacks() {
  const policyPath = path.resolve(__dirname, '..', 'website', 'policies.html');
  const policyHtml = fs.readFileSync(policyPath, 'utf8');
  fs.writeFileSync(policyPath, renderPolicyPublicationFallbacks(policyHtml, publication), 'utf8');
  console.log(`Synchronized two policy fallbacks for ${publication.version}.`);
}

if (require.main === module) synchronizePolicyPublicationFallbacks();

module.exports = { renderPolicyPublicationFallbacks, synchronizePolicyPublicationFallbacks };
