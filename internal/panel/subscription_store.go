package panel

import (
	"crypto/rand"
	"errors"
	"net"
	"strings"
	"unicode"
)

type SubscriptionNode struct {
	ServerID string `json:"server_id"`
	Tag      string `json:"tag"`
}

type SubscriptionEndpoint struct {
	SubscriptionNode
	Name       string `json:"name,omitempty"`
	Address    string `json:"address"`
	Port       int    `json:"port"`
	ServerName string `json:"server_name"`
}

type SubscriptionGroup struct {
	ID      string               `json:"id,omitempty"`
	Type    string               `json:"type"`
	Tag     string               `json:"tag"`
	Members []SubscriptionMember `json:"members"`
}

type SubscriptionMember struct {
	Kind     string `json:"kind"`
	ServerID string `json:"server_id,omitempty"`
	Tag      string `json:"tag,omitempty"`
	GroupID  string `json:"group_id,omitempty"`
}

type SubscriptionDirect struct {
	Enabled bool   `json:"enabled"`
	Tag     string `json:"tag"`
}

type Subscription struct {
	ID         string                 `json:"id"`
	Name       string                 `json:"name"`
	Content    string                 `json:"content,omitempty"`
	Templates  []ConfigTemplate       `json:"templates,omitempty"`
	UserID     string                 `json:"user_id"`
	Scope      string                 `json:"scope"`
	Servers    []string               `json:"servers"`
	Nodes      []SubscriptionNode     `json:"nodes"`
	Endpoints  []SubscriptionEndpoint `json:"endpoints"`
	Groups     []SubscriptionGroup    `json:"groups"`
	Direct     *SubscriptionDirect    `json:"direct,omitempty"`
	Token      string                 `json:"token"`
	ResetToken bool                   `json:"reset_token,omitempty"`
}

func prepareSubscriptions(next *Library, previous Library) error {
	if len(next.Subscriptions) > 256 {
		return errors.New("at most 256 subscriptions are supported")
	}
	if next.Subscriptions == nil {
		next.Subscriptions = []Subscription{}
	}
	old := make(map[string]Subscription, len(previous.Subscriptions))
	for _, item := range previous.Subscriptions {
		old[item.ID] = item
	}
	for index := range next.Subscriptions {
		item := &next.Subscriptions[index]
		item.Name = strings.TrimSpace(item.Name)
		if item.Direct != nil {
			item.Direct.Tag = strings.TrimSpace(item.Direct.Tag)
		}
		for index := range item.Groups {
			item.Groups[index].Tag = strings.TrimSpace(item.Groups[index].Tag)
		}
		for index := range item.Endpoints {
			item.Endpoints[index].Name = strings.TrimSpace(item.Endpoints[index].Name)
		}
		if len(item.Templates) > 0 {
			item.Content = ""
		}
		if err := validateSubscription(*item); err != nil {
			return err
		}
		before, exists := old[item.ID]
		if !exists || item.ResetToken || before.Token == "" {
			item.Token = rand.Text() + rand.Text()
		} else {
			item.Token = before.Token
		}
		item.ResetToken = false
	}
	return nil
}

func validateSubscription(item Subscription) error {
	if item.ID == "" || len(item.ID) > 80 || strings.ContainsAny(item.ID, `/\\`) || item.Name == "" || len(item.Name) > 128 || len(item.UserID) > 80 {
		return errors.New("invalid subscription name or identifier")
	}
	if _, err := subscriptionConfiguration(item); err != nil {
		return err
	}
	if item.Scope != "all" && item.Scope != "servers" && item.Scope != "nodes" {
		return errors.New("invalid subscription scope")
	}
	if item.Direct != nil {
		if item.Scope != "nodes" {
			return errors.New("node selection is required")
		}
		if len(item.Direct.Tag) > 512 || (item.Direct.Enabled && strings.TrimSpace(item.Direct.Tag) == "") {
			return &subscriptionConfigError{Code: "invalid_direct_name"}
		}
	}
	if len(item.Servers) > 64 || len(item.Nodes) > 4096 || len(item.Endpoints) > 4096 || len(item.Groups) > 128 {
		return errors.New("subscription has too many selections or groups")
	}
	validNode := func(node SubscriptionNode) bool {
		return node.ServerID != "" && len(node.ServerID) <= 80 && node.Tag != "" && len(node.Tag) <= 512 && !strings.ContainsRune(node.ServerID+node.Tag, '\x00')
	}
	seen := map[string]bool{}
	for _, id := range item.Servers {
		if id == "" || len(id) > 80 || seen[id] {
			return errors.New("invalid or duplicate subscription server")
		}
		seen[id] = true
	}
	clear(seen)
	for _, node := range item.Nodes {
		key := node.ServerID + "\x00" + node.Tag
		if !validNode(node) || seen[key] {
			return errors.New("invalid or duplicate subscription node")
		}
		seen[key] = true
	}
	clear(seen)
	for _, endpoint := range item.Endpoints {
		key := endpoint.ServerID + "\x00" + endpoint.Tag
		if !validNode(endpoint.SubscriptionNode) || seen[key] || len(endpoint.Name) > 512 || endpoint.Port < 0 || endpoint.Port > 65535 || (endpoint.Address != "" && !validClientAddress(endpoint.Address)) || len(endpoint.ServerName) > 253 || strings.ContainsAny(endpoint.ServerName, "/\\\r\n\t ") {
			return errors.New("invalid or duplicate subscription endpoint")
		}
		seen[key] = true
	}
	clear(seen)
	groupIDs := map[string]bool{}
	for _, group := range item.Groups {
		if (group.Type != "selector" && group.Type != "urltest" && (item.Direct != nil || group.Type != "direct")) || strings.TrimSpace(group.Tag) == "" || len(group.Tag) > 512 || seen[group.Tag] {
			return &subscriptionConfigError{Code: "invalid_group", Reference: group.Tag}
		}
		seen[group.Tag] = true
		if item.Direct == nil {
			continue
		}
		if group.ID == "" || len(group.ID) > 80 || strings.ContainsRune(group.ID, '\x00') || groupIDs[group.ID] || len(group.Members) > 4225 {
			return &subscriptionConfigError{Code: "invalid_group", Reference: group.Tag}
		}
		groupIDs[group.ID] = true
		members := map[string]bool{}
		for _, member := range group.Members {
			valid := false
			switch member.Kind {
			case "node":
				valid = validNode(SubscriptionNode{ServerID: member.ServerID, Tag: member.Tag}) && member.GroupID == ""
			case "group":
				valid = member.GroupID != "" && len(member.GroupID) <= 80 && !strings.ContainsRune(member.GroupID, '\x00') && member.ServerID == "" && member.Tag == ""
			case "direct":
				valid = member.ServerID == "" && member.Tag == "" && member.GroupID == ""
			}
			key := subscriptionMemberKey(member)
			if !valid || members[key] {
				return &subscriptionConfigError{Code: "invalid_group_member", Reference: group.Tag}
			}
			members[key] = true
		}
	}
	if item.Direct != nil {
		names, order := map[string]string{}, []string{}
		for _, node := range item.Nodes {
			key := subscriptionNodeKey(node)
			names[key] = node.Tag
			order = append(order, key)
		}
		if _, err := subscriptionGroupOutbounds(item, names, order); err != nil {
			return err
		}
	}
	return nil
}

func validClientAddress(value string) bool {
	if value == "" || len(value) > 253 || strings.IndexFunc(value, unicode.IsSpace) >= 0 || strings.ContainsAny(value, `/\\@?#[]`) {
		return false
	}
	if ip := net.ParseIP(value); ip != nil {
		return !ip.IsUnspecified()
	}
	return !strings.Contains(value, ":")
}
