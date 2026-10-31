// Loaded via a classic <script src> tag rather than fetched as JSON: fetch()
// and XHR are blocked cross-origin when index.html is opened as a file://
// URL, but script tags aren't - so this is the one format that works whether
// index.html is served over HTTP(S)/IPFS/.eth or opened straight off disk.
//
// Every entry is { id, label }: id is whatever runBootstrap's resolution
// functions expect (a handle/DID for follows, an AT-URI for everything
// else), label is the human-readable name shown next to its checkbox on
// the create-account page - looked up once by hand via the AppView
// (app.bsky.graph.getStarterPack / app.bsky.feed.getFeedGenerator /
// app.bsky.graph.getList) and hardcoded here, rather than fetched live on
// every page load for a handful of names that essentially never change.
window.BOOTSTRAP_CONFIG = {
    // DIDs or handles to follow directly.
    follows: [],
    // Feed generators to add to the account's saved feeds. "following" is
    // the special value for the built-in following timeline, not a real
    // feed generator (no AppView lookup for it - it's not a record).
    feeds: [
        { id: 'following', label: 'Following' },
        { id: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/mutuals', label: 'Mutuals (see posts from your mutual follows)' },
        { id: 'at://did:plc:3guzzweuqraryl3rdkimjamk/app.bsky.feed.generator/for-you', label: 'For You (a personalized algorithmic feed based on your likes)' }
    ],
    // Moderation lists to subscribe to (app.bsky.graph.listblock).
    blocklists: [
        { id: 'at://did:plc:s45hbf5dqdkjpwuuq4djo6l2/app.bsky.graph.list/3lzefe5k2432n', label: 'AI Haters (moderation list, 300k+ accounts)' }
    ],
    // Curation lists whose members get added to follows.
    lists: [],
    // Starter packs: members of the pack's list are added to follows, and
    // the pack's bundled feeds (if any) are added to saved feeds.
    starterpacks: [
        { id: 'at://did:plc:pyzlzqt6b2nyrha7smfry6rv/app.bsky.graph.starterpack/3llqccb5wea2x', label: 'Decentralization, p2p, ethereum, non-scammy crypto (starter pack, ~74 accounts)' }
    ]
};
