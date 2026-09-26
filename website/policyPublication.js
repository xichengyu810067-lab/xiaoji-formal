(function publishPolicyPublication(root, factory) {
  const publication = factory({
    version: '1.1.0',
    lastUpdatedDate: '2026 年 9 月 26 日',
    effectiveDate: '2026 年 9 月 26 日',
  });

  if (typeof module === 'object' && module.exports) {
    module.exports = Object.freeze({ createPolicyPublication: factory, publication });
  }

  if (!root) return;
  root.XiaojiPolicyPublication = publication;
  root.document.querySelectorAll('[data-policy-publication]').forEach((node) => {
    node.textContent = publication.displayText;
  });
})(typeof window === 'undefined' ? null : window, function createPolicyPublication({ version, lastUpdatedDate, effectiveDate }) {
  if (!version || !lastUpdatedDate) throw new Error('policy_publication_metadata_invalid');

  const displayText = effectiveDate
    ? `版本：${version}。生效日期：${effectiveDate}。最後更新：${lastUpdatedDate}。本政策適用於小吉已啟用的功能。`
    : `最後更新：${lastUpdatedDate}。尚未生效：本政策中與 ${version} 功能相關的說明，將在該版本完成啟用並部署時生效；在此之前，仍適用目前已啟用功能的既有使用者政策與隱私權政策。`;

  return Object.freeze({ version, lastUpdatedDate, effectiveDate, displayText });
});
