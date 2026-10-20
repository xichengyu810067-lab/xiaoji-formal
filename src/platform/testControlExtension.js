'use strict';

function selectExtensionHost(policy, { createEmpty, loadPrivate }) {
  return policy ? createEmpty() : loadPrivate();
}

module.exports = { selectExtensionHost };
