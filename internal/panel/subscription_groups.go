package panel

import "strings"

func subscriptionMemberKey(member SubscriptionMember) string {
	return member.Kind + "\x00" + member.ServerID + "\x00" + member.Tag + "\x00" + member.GroupID
}

func subscriptionGroupOutbounds(profile Subscription, nodes map[string]string, nodeOrder []string) ([]configObject, *subscriptionConfigError) {
	groups := make(map[string]SubscriptionGroup, len(profile.Groups))
	for _, group := range profile.Groups {
		groups[group.ID] = group
	}
	colors := map[string]uint8{}
	var visit func(string, []string) *subscriptionConfigError
	visit = func(id string, path []string) *subscriptionConfigError {
		group, exists := groups[id]
		if !exists {
			return &subscriptionConfigError{Code: "group_member_missing", Reference: strings.Join(path, " → ")}
		}
		if colors[id] == 1 {
			return &subscriptionConfigError{Code: "group_cycle", Reference: strings.Join(append(path, group.Tag), " → ")}
		}
		if colors[id] == 2 {
			return nil
		}
		colors[id] = 1
		for _, member := range group.Members {
			if member.Kind == "group" {
				if err := visit(member.GroupID, append(path, group.Tag)); err != nil {
					return err
				}
			}
		}
		colors[id] = 2
		return nil
	}
	for _, group := range profile.Groups {
		if err := visit(group.ID, nil); err != nil {
			return nil, err
		}
	}
	selected := map[string]bool{}
	for _, node := range profile.Nodes {
		selected[subscriptionNodeKey(node)] = true
	}
	result := make([]configObject, 0, len(profile.Groups)+1)
	for _, group := range profile.Groups {
		wantedNodes, wantedGroups, direct := map[string]bool{}, map[string]bool{}, false
		for _, member := range group.Members {
			switch member.Kind {
			case "node":
				key := subscriptionNodeKey(SubscriptionNode{ServerID: member.ServerID, Tag: member.Tag})
				if !selected[key] {
					return nil, &subscriptionConfigError{Code: "group_member_missing", Reference: group.Tag + " · " + member.Tag}
				}
				wantedNodes[key] = true
			case "group":
				wantedGroups[member.GroupID] = true
			case "direct":
				if !profile.Direct.Enabled {
					return nil, &subscriptionConfigError{Code: "group_member_missing", Reference: group.Tag + " · " + profile.Direct.Tag}
				}
				direct = true
			}
		}
		members := []string{}
		for _, candidate := range profile.Groups {
			if wantedGroups[candidate.ID] {
				members = append(members, candidate.Tag)
			}
		}
		defaultTag, fallbackGroup := "", ""
		if len(members) > 0 {
			fallbackGroup = members[0]
		}
		for _, candidate := range profile.Groups {
			if wantedGroups[candidate.ID] && candidate.Type == "urltest" {
				defaultTag = candidate.Tag
				break
			}
		}
		if direct {
			members = append(members, profile.Direct.Tag)
		}
		for _, key := range nodeOrder {
			if wantedNodes[key] {
				members = append(members, nodes[key])
				if defaultTag == "" {
					defaultTag = nodes[key]
				}
			}
		}
		if len(members) == 0 {
			return nil, &subscriptionConfigError{Code: "empty_group", Reference: group.Tag}
		}
		out := configObject{"type": group.Type, "tag": group.Tag, "outbounds": members}
		if group.Type == "selector" {
			if defaultTag == "" {
				defaultTag = fallbackGroup
			}
			if defaultTag == "" {
				defaultTag = members[0]
			}
			out["default"] = defaultTag
		}
		result = append(result, out)
	}
	if profile.Direct.Enabled {
		result = append(result, configObject{"type": "direct", "tag": profile.Direct.Tag})
	}
	return result, nil
}
