// Product display name. Deliberately a constant, NOT package.json
// `productName`: adding that field would change Electron's default userData
// directory (~/Library/Application Support/@botiverse/raft-desktop-electron
// → .../Raft Desktop), silently losing the user's login session, window
// state, and moving the single-instance lock. Changing the real app name
// someday needs an explicit `app.setPath("userData", <old path>)` migration
// first; until then every menu label reads this constant.
export const PRODUCT_NAME = "Raft Desktop";
