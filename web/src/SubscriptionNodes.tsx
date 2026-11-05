import { useState } from "react";
import { Dialog, Icon, IconButton, useUI } from "./ui";
import { Select } from "./vendor/PreferenceControls";
import {
  newID,
  type Subscription,
  type SubscriptionEndpoint,
  type SubscriptionGroup,
  type SubscriptionMember,
  type SubscriptionNode,
} from "./library";
import {
  groupWouldCycle,
  memberKey,
  nodeKey,
  nodeMember,
  selectSubscriptionNodes,
  subscriptionMessage,
  subscriptionNodeRows,
  type SubscriptionNodeRow,
  type SubscriptionSource,
} from "./subscriptions";

type Update = (value: Partial<Subscription>) => void;

function nodeRows(profile: Subscription, sources: SubscriptionSource[]) {
  const rows = subscriptionNodeRows(sources);
  const keys = new Set(rows.map(nodeKey));
  for (const node of profile.nodes)
    if (!keys.has(nodeKey(node)))
      rows.push({
        ...node,
        key: nodeKey(node),
        name: node.tag,
        type: "",
        address: "",
        port: 0,
        server_name: "",
        issue: "selection_missing",
      });
  return rows;
}

function memberName(
  profile: Subscription,
  rows: SubscriptionNodeRow[],
  member: SubscriptionMember,
) {
  if (member.kind === "direct") return profile.direct?.tag || "direct";
  if (member.kind === "group")
    return (
      profile.groups.find((group) => group.id === member.group_id)?.tag ||
      member.group_id ||
      ""
    );
  const reference = {
    server_id: member.server_id || "",
    tag: member.tag || "",
  };
  return (
    profile.endpoints.find((node) => nodeKey(node) === nodeKey(reference))
      ?.name ||
    rows.find((node) => nodeKey(node) === nodeKey(reference))?.name ||
    member.tag ||
    ""
  );
}

export default function SubscriptionNodes({
  profile,
  sources,
  busy,
  update,
}: {
  profile: Subscription;
  sources: SubscriptionSource[];
  busy: boolean;
  update: Update;
}) {
  const { t } = useUI();
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const rows = nodeRows(profile, sources);
  const selected = new Set(profile.nodes.map(nodeKey));
  const available = rows.filter((node) => node.tag && !node.issue);
  const all =
    !!profile.direct?.enabled &&
    available.every((node) => selected.has(nodeKey(node)));
  const some = !!profile.direct?.enabled || profile.nodes.length > 0;
  const group = profile.groups.find((item) => item.id === editingGroup);
  function editEndpoint(
    node: SubscriptionNode,
    patch: Partial<SubscriptionEndpoint>,
  ) {
    const previous = profile.endpoints.find(
      (item) => nodeKey(item) === nodeKey(node),
    );
    const next: SubscriptionEndpoint = {
      server_id: node.server_id,
      tag: node.tag,
      address: "",
      port: 0,
      server_name: "",
      ...previous,
      ...patch,
    };
    const rest = profile.endpoints.filter(
      (item) => nodeKey(item) !== nodeKey(node),
    );
    update({
      endpoints:
        next.name !== undefined || next.address || next.port || next.server_name
          ? [...rest, next]
          : rest,
    });
  }
  return (
    <>
      <section className="subscription-section">
        <div className="library-card-heading">
          <strong>{t("节点", "Nodes")}</strong>
          <label className="subscription-select-all">
            <input
              type="checkbox"
              checked={all}
              ref={(input) => {
                if (input) input.indeterminate = some && !all;
              }}
              disabled={busy}
              onChange={(event) => {
                const byKey = new Map(
                  profile.nodes.map((node) => [nodeKey(node), node]),
                );
                for (const node of available)
                  byKey.set(nodeKey(node), {
                    server_id: node.server_id,
                    tag: node.tag,
                  });
                update(
                  selectSubscriptionNodes(
                    profile,
                    event.target.checked ? [...byKey.values()] : [],
                    event.target.checked,
                  ),
                );
              }}
            />
            {t("全选", "Select all")}
          </label>
        </div>
        <div className="subscription-endpoints">
          <div className="subscription-endpoint-row subscription-endpoint-heading">
            <span />
            <span>{t("名称", "Name")}</span>
            <span>{t("对外地址", "Public address")}</span>
            <span>{t("端口", "Port")}</span>
            <span>SNI</span>
            <span />
          </div>
          <div className="subscription-endpoint-row">
            <input
              type="checkbox"
              aria-label={t("包含直连", "Include direct")}
              checked={!!profile.direct?.enabled}
              onChange={(event) =>
                update(
                  selectSubscriptionNodes(
                    profile,
                    profile.nodes,
                    event.target.checked,
                  ),
                )
              }
            />
            <div className="subscription-node-identity">
              <input
                className="input"
                aria-label={t("直连组名称", "Direct group name")}
                value={profile.direct?.tag ?? "direct"}
                maxLength={512}
                onChange={(event) =>
                  update({
                    direct: {
                      enabled: !!profile.direct?.enabled,
                      tag: event.target.value,
                    },
                  })
                }
              />
            </div>
            <span className="hint">—</span>
            <span className="hint">—</span>
            <span className="hint">—</span>
            <span />
          </div>
          {rows.map((node) => {
            const endpoint = profile.endpoints.find(
              (item) => nodeKey(item) === nodeKey(node),
            );
            const checked = selected.has(nodeKey(node));
            return (
              <div className="subscription-endpoint-row" key={node.key}>
                <input
                  type="checkbox"
                  aria-label={`${t("包含节点", "Include node")} · ${node.name}`}
                  checked={checked}
                  disabled={!!node.issue && !checked}
                  onChange={(event) =>
                    update(
                      selectSubscriptionNodes(
                        profile,
                        event.target.checked
                          ? [
                              ...profile.nodes,
                              { server_id: node.server_id, tag: node.tag },
                            ]
                          : profile.nodes.filter(
                              (item) => nodeKey(item) !== nodeKey(node),
                            ),
                      ),
                    )
                  }
                />
                <div
                  className="subscription-node-identity"
                  title={[
                    node.name,
                    node.type,
                    node.issue && subscriptionMessage(node.issue, t),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <input
                    className="input"
                    aria-label={`${t("节点名称", "Node name")} · ${node.name}`}
                    value={endpoint?.name ?? node.name}
                    disabled={!!node.issue}
                    maxLength={512}
                    onChange={(event) =>
                      editEndpoint(node, { name: event.target.value })
                    }
                  />
                </div>
                <input
                  className="input mono-input"
                  aria-label={`${node.name} · ${t("对外地址", "Public address")}`}
                  value={endpoint?.address || ""}
                  disabled={!!node.issue}
                  placeholder={node.address}
                  maxLength={253}
                  onChange={(event) =>
                    editEndpoint(node, { address: event.target.value.trim() })
                  }
                />
                <input
                  className="input mono-input"
                  aria-label={`${node.name} · ${t("端口", "Port")}`}
                  type="number"
                  min={1}
                  max={65535}
                  value={endpoint?.port || ""}
                  disabled={!!node.issue}
                  placeholder={String(node.port || "")}
                  onChange={(event) =>
                    editEndpoint(node, {
                      port: event.target.value ? Number(event.target.value) : 0,
                    })
                  }
                />
                <input
                  className="input mono-input"
                  aria-label={`${node.name} · SNI`}
                  value={endpoint?.server_name || ""}
                  disabled={!!node.issue}
                  placeholder={node.server_name}
                  maxLength={253}
                  onChange={(event) =>
                    editEndpoint(node, {
                      server_name: event.target.value.trim(),
                    })
                  }
                />
                <IconButton
                  icon="close"
                  label={t(
                    "恢复默认名称和连接参数",
                    "Reset name and connection settings",
                  )}
                  disabled={!endpoint}
                  onClick={() =>
                    update({
                      endpoints: profile.endpoints.filter(
                        (item) => nodeKey(item) !== nodeKey(node),
                      ),
                    })
                  }
                />
              </div>
            );
          })}
        </div>
        {sources
          .filter((source) => source.issue)
          .map((source) => (
            <p className="hint" key={source.id}>
              {source.name} · {subscriptionMessage(source.issue!, t)}
            </p>
          ))}
      </section>
      <section className="subscription-section">
        <div className="library-card-heading">
          <strong>{t("出站组", "Outbound groups")}</strong>
          <button
            type="button"
            className="button small"
            disabled={busy}
            onClick={() => {
              const type = profile.groups.some(
                (item) => item.type === "urltest",
              )
                ? "selector"
                : "urltest";
              const prefix = type === "urltest" ? "auto" : "proxy";
              let tag = prefix,
                index = 2;
              while (
                profile.groups.some((item) => item.tag === tag) ||
                profile.direct?.tag === tag
              )
                tag = `${prefix}${index++}`;
              update({
                groups: [
                  ...profile.groups,
                  { id: newID(), type, tag, members: [] },
                ],
              });
            }}
          >
            <Icon name="add" />
            {t("添加", "Add")}
          </button>
        </div>
        {profile.groups.map((item) => (
          <div className="subscription-group-card" key={item.id}>
            <div className="subscription-group">
              <Select
                value={item.type}
                disabled={busy}
                options={[
                  { value: "selector", label: t("选择", "Selector") },
                  { value: "urltest", label: t("测速", "URLTest") },
                ]}
                onChange={(type) =>
                  update({
                    groups: profile.groups.map((value) =>
                      value.id === item.id ? { ...value, type } : value,
                    ),
                  })
                }
              />
              <input
                className="input"
                aria-label={t("出站组名称", "Outbound group name")}
                value={item.tag}
                maxLength={512}
                required
                onChange={(event) =>
                  update({
                    groups: profile.groups.map((value) =>
                      value.id === item.id
                        ? { ...value, tag: event.target.value }
                        : value,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="button small"
                disabled={busy}
                title={(item.members || [])
                  .slice(0, 8)
                  .map((member) => memberName(profile, rows, member))
                  .join("、")}
                onClick={() => setEditingGroup(item.id!)}
              >
                <Icon name="check" />
                {t("选择节点/出站组", "Select nodes/groups")} (
                {item.members?.length || 0})
              </button>
              <IconButton
                icon="delete"
                label={t("删除出站组", "Delete outbound group")}
                disabled={busy}
                onClick={() =>
                  update({
                    groups: profile.groups
                      .filter((value) => value.id !== item.id)
                      .map((value) => ({
                        ...value,
                        members: (value.members || []).filter(
                          (member) =>
                            member.kind !== "group" ||
                            member.group_id !== item.id,
                        ),
                      })),
                  })
                }
              />
            </div>
          </div>
        ))}
      </section>
      {group && (
        <GroupMembers
          profile={profile}
          group={group}
          rows={rows}
          close={() => setEditingGroup(null)}
          apply={(members) => {
            update({
              groups: profile.groups.map((item) =>
                item.id === group.id ? { ...item, members } : item,
              ),
            });
            setEditingGroup(null);
          }}
        />
      )}
    </>
  );
}

function GroupMembers({
  profile,
  group,
  rows,
  close,
  apply,
}: {
  profile: Subscription;
  group: SubscriptionGroup;
  rows: SubscriptionNodeRow[];
  close: () => void;
  apply: (members: SubscriptionMember[]) => void;
}) {
  const { t } = useUI();
  const [chosen, setChosen] = useState(group.members || []);
  const selectedNodes = new Set(profile.nodes.map(nodeKey));
  const options: {
    member: SubscriptionMember;
    name: string;
    section: "groups" | "nodes";
    issue?: string;
  }[] = [];
  if (profile.direct?.enabled)
    options.push({
      member: { kind: "direct" },
      name: `${profile.direct.tag} · ${t("直连", "Direct")}`,
      section: "groups",
    });
  for (const item of profile.groups)
    if (item.id !== group.id)
      options.push({
        member: { kind: "group", group_id: item.id },
        name: `${item.tag || t("未命名组", "Unnamed group")} · ${item.type === "selector" ? t("选择", "Selector") : t("测速", "URLTest")}`,
        section: "groups",
        issue: groupWouldCycle(profile.groups, group.id!, item.id!)
          ? "group_cycle"
          : undefined,
      });
  for (const node of rows)
    if (selectedNodes.has(nodeKey(node)))
      options.push({
        member: nodeMember(node),
        name: memberName(profile, rows, nodeMember(node)),
        section: "nodes",
        issue: node.issue,
      });
  const keys = new Set(options.map((option) => memberKey(option.member)));
  for (const member of group.members || [])
    if (!keys.has(memberKey(member)))
      options.push({
        member,
        name: memberName(profile, rows, member),
        section: member.kind === "node" ? "nodes" : "groups",
        issue: "group_member_missing",
      });
  return (
    <Dialog
      title={`${group.tag || t("出站组", "Outbound group")} · ${t("选择成员", "Select members")}`}
      className="library-editor-dialog subscription-template-picker"
      onClose={close}
    >
      <div className="subscription-dialog-body">
        {(["groups", "nodes"] as const).map((section) => (
          <section className="subscription-member-section" key={section}>
            <strong>
              {section === "groups"
                ? t("出站组", "Outbound groups")
                : t("节点", "Nodes")}
            </strong>
            {options
              .filter((option) => option.section === section)
              .map((option) => {
                const key = memberKey(option.member),
                  checked = chosen.some((member) => memberKey(member) === key);
                return (
                  <label className="library-user-option" key={key}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!!option.issue && !checked}
                      onChange={(event) =>
                        setChosen((previous) =>
                          event.target.checked
                            ? [...previous, option.member]
                            : previous.filter(
                                (member) => memberKey(member) !== key,
                              ),
                        )
                      }
                    />
                    <span>{option.name}</span>
                    {option.issue && (
                      <span className="hint">
                        {subscriptionMessage(option.issue, t)}
                      </span>
                    )}
                  </label>
                );
              })}
            {!options.some((option) => option.section === section) && (
              <p className="hint">
                {section === "groups"
                  ? t("暂无其他出站组", "No other outbound groups")
                  : t("未选择节点", "No nodes selected")}
              </p>
            )}
          </section>
        ))}
      </div>
      <div className="row-actions dialog-actions">
        <button type="button" className="button" onClick={close}>
          {t("取消", "Cancel")}
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => apply(chosen)}
        >
          {t("确定", "Apply")} ({chosen.length})
        </button>
      </div>
    </Dialog>
  );
}
