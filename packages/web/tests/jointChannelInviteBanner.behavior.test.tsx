import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { JointChannelInviteBanner } from "../src/components/channel/JointChannelInviteBanner";
import api from "../src/api/client";
import { useChannelStore } from "../src/store/channelStore";
import { useJointChannelInviteStore } from "../src/store/jointChannelInviteStore";
import { TestIntlProvider } from "./helpers/intl";

const invite = {
  id: "inv-1",
  jointChannelId: "joint-1",
  fromServerName: "RaftBuild",
  fromServerSlug: "raftbuild",
  channelName: "IT",
  channelDescription: null,
  invitedByUserId: "user-1",
  expiresAt: "2026-10-02T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
};

const originalPost = api.post;

afterEach(() => {
  cleanup();
  api.post = originalPost;
  useJointChannelInviteStore.setState({
    serverId: null,
    invites: [],
    dismissedIds: [],
    acceptingId: null,
    errors: {},
  });
});

function seed() {
  useJointChannelInviteStore.setState({
    serverId: "server-1",
    invites: [invite],
    dismissedIds: [],
    acceptingId: null,
    errors: {},
  });
}

function mount(opened: string[]) {
  return render(createElement(
    TestIntlProvider,
    null,
    createElement(JointChannelInviteBanner, {
      onOpenChannel: (channelId: string) => opened.push(channelId),
    }),
  ));
}

test("later hides the sidebar invite without accepting it", () => {
  seed();
  const view = mount([]);
  assert.match(view.container.textContent ?? "", /RaftBuild invited you to join joint channel #IT/);
  fireEvent.click(screen.getByTestId("joint-invite-later"));
  assert.equal(screen.queryByTestId("joint-invite-banner"), null);
  assert.equal(useJointChannelInviteStore.getState().invites.length, 1);
});

test("accept opens the channel and removes the invite", async () => {
  const opened: string[] = [];
  seed();
  useChannelStore.setState({ ensureChannel: async () => null } as never);
  api.post = (async (url: string) => {
    assert.equal(url, "/channels/joint-invites/inv-1/accept");
    return { data: { id: "chan-1" } };
  }) as typeof api.post;
  mount(opened);
  fireEvent.click(screen.getByTestId("joint-invite-accept"));
  await waitFor(() => assert.deepEqual(opened, ["chan-1"]));
  assert.equal(useJointChannelInviteStore.getState().invites.length, 0);
});

test("accept shows the server error text", async () => {
  seed();
  api.post = (async () => {
    throw { response: { data: { error: "Invite expired" } } };
  }) as typeof api.post;
  mount([]);
  fireEvent.click(screen.getByTestId("joint-invite-accept"));
  await waitFor(() => assert.equal(screen.getByTestId("joint-invite-error").textContent, "Invite expired"));
  assert.equal(useJointChannelInviteStore.getState().invites.length, 1);
});
