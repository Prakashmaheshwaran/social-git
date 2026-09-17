const post = (id = "300") => ({
  __typename: "Tweet",
  rest_id: id,
  legacy: {
    full_text: "Synthetic pinned-corpus post",
    user_id_str: "200",
    created_at: "Tue May 18 03:33:20 +0000 2033",
    reply_count: 1,
    retweet_count: 2,
    favorite_count: 3,
    quote_count: 0,
    conversation_id_str: id,
  },
  core: { user_results: { result: { rest_id: "200", legacy: { screen_name: "fixture_owner" } } } },
});

export const X_RECORDED_SYNTHETIC_CORPUS = Object.freeze({
  identity: {
    status: 200,
    headers: rate(),
    body: { user_id: "100", screen_name: "fixture_id", name: "Fixture Identity" },
  },
  profile: {
    status: 200,
    headers: rate(),
    body: { data: { user: { result: {
      __typename: "User",
      rest_id: "200",
      legacy: {
        screen_name: "fixture_owner",
        name: "Fixture Owner",
        description: "Synthetic",
        followers_count: 10,
        friends_count: 5,
        created_at: "Tue May 18 03:33:20 +0000 2033",
        verified: false,
      },
    } } } },
  },
  post: {
    status: 200,
    headers: rate(),
    body: { data: { tweetResult: { result: post() } } },
  },
  page: {
    status: 200,
    headers: rate(),
    body: { data: { timeline: { instructions: [{ entries: [
      {
        entryId: "tweet-300",
        content: { entryType: "TimelineTimelineItem", itemContent: { tweet_results: { result: post() } } },
      },
      {
        entryId: "cursor-bottom",
        content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: "opaque-next" },
      },
    ] }] } } },
  },
  notificationPage: {
    status: 200,
    headers: rate(),
    body: {
      globalObjects: { notifications: { "400": {
        id: "400",
        type: "mention",
        timestampMs: "2000000000000",
        message: { text: "Synthetic mention" },
        template: { aggregateUserActionsV1: { targetObjects: [{ tweet: { id: "300" } }] } },
      } } },
      timeline: { instructions: [{ entries: [] }] },
    },
  },
  conversationPage: {
    status: 200,
    headers: rate(),
    body: { inbox_initial_state: {
      conversations: { "100-200": {
        conversation_id: "100-200",
        sort_event_id: "500",
        participants: [{ user_id: "100" }, { user_id: "200" }],
        last_read_event_id: "499",
      } },
      entries: [{ message: {
        id: "500",
        time: "2000000000000",
        message_data: { text: "Synthetic DM", sender_id: "200" },
        conversation_id: "100-200",
      } }],
      min_entry_id: "500",
    } },
  },
  write: {
    status: 200,
    headers: rate(),
    body: { data: { result: { rest_id: "600", legacy: { id_str: "600" } } } },
  },
  mediaInit: {
    status: 200,
    headers: rate(),
    body: { media_id_string: "700", expires_after_secs: 300 },
  },
  mediaAppend: { status: 200, headers: rate(), body: {} },
  mediaFinalize: { status: 200, headers: rate(), body: { media_id_string: "700" } },
});

function rate() {
  return {
    "x-rate-limit-limit": "50",
    "x-rate-limit-remaining": "49",
    "x-rate-limit-reset": "2000000000",
  };
}
