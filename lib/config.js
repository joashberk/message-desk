// Non-secret settings. Secrets (keys and tokens) only ever come from environment variables.

export const CONFIG = {
  // Every Drive call runs as this account, so every file is owned by and stored on it.
  driveAccount: 'sentlifecenter.tech@gmail.com',

  // 01_SLC Media Library (owned by info@sentlifecenter.com, shared with the account above as editor)
  libraryFolderId: process.env.LIBRARY_FOLDER_ID || '1S5qPnpWJdjfN_LtmWVMFmv3KHyZWz-xs',

  // Lives in the root of the account's My Drive. Holds uploads in progress, previews and app state.
  workingFolderName: 'Message Desk working files',

  githubRepo: process.env.GITHUB_REPO || 'joashberk/message-desk',
  githubBranch: process.env.GITHUB_BRANCH || 'main',

  webflow: {
    siteId: '657cd6db72c68edf173df376',
    domain: 'sentlifecenter.com',
    speakersCollectionId: '65a039414cd97874b06e854d',
    collections: {
      Sunday: { id: '65a03ab49a08fddc920bd324', slug: 'sunday-messages', name: 'Sunday Messages' },
      Hebron: { id: '65a5b1811105c5f7ba94fd8a', slug: 'hebron-messages', name: 'Hebron Messages' },
      Charis: { id: '65a5b18be67bdf9959cc6908', slug: 'charis-messages', name: 'Charis Messages' }
    }
  },

  // Drive filing rules per collection
  collections: {
    Sunday: { folder: (y) => '01_SLC_Sundays_' + y, code: 'Sunday' },
    Hebron: { folder: () => '03_HEBRON', code: 'HEBRON' },
    Charis: { folder: () => '04_Charis/X-Elle', code: 'CX' }
  }
};

export const COLLS = ['Sunday', 'Hebron', 'Charis'];

export function env(name, required = true) {
  const v = process.env[name];
  if (required && !v) {
    const e = new Error('Missing setting ' + name);
    e.code = 'MISSING_ENV';
    e.envName = name;
    throw e;
  }
  return v || '';
}

export function allowedEmails() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
