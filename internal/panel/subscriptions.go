package panel

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strings"

	"github.com/zahuiron/sing-box-manager/internal/agent"
)

type SubscriptionSourceNode struct {
	Tag        string `json:"tag"`
	Type       string `json:"type"`
	Port       int    `json:"port"`
	ServerName string `json:"server_name"`
	Issue      string `json:"issue,omitempty"`
}

type SubscriptionSource struct {
	ID      string                   `json:"id"`
	Name    string                   `json:"name"`
	Address string                   `json:"address"`
	Nodes   []SubscriptionSourceNode `json:"nodes"`
	Issue   string                   `json:"issue,omitempty"`
}

type SubscriptionIssue struct {
	Server string `json:"server,omitempty"`
	Node   string `json:"node,omitempty"`
	Code   string `json:"code"`
}

type SubscriptionResult struct {
	Content   string              `json:"content,omitempty"`
	Count     int                 `json:"count"`
	Issues    []SubscriptionIssue `json:"issues"`
	Error     string              `json:"error,omitempty"`
	Reference string              `json:"reference,omitempty"`
}

func (s *Store) visitSubscriptionSources(only map[string]bool, visit func(SubscriptionSource, configObject)) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, record := range s.data.Servers {
		if only != nil && !only[record.ID] {
			continue
		}
		address, _ := url.Parse(record.URL)
		source := SubscriptionSource{ID: record.ID, Name: record.Name, Nodes: []SubscriptionSourceNode{}}
		if address != nil {
			source.Address = address.Hostname()
		}
		draft, err := s.readDraftLocked(record.ID)
		var root configObject
		if err != nil || draft.PublishedContent == "" || draft.SourceURL != record.URL {
			source.Issue = "snapshot_unavailable"
		} else if json.Unmarshal(agent.CleanJSONC([]byte(draft.PublishedContent)), &root) != nil || root == nil {
			source.Issue = "invalid_snapshot"
		}
		if source.Issue == "" {
			tags := map[string]int{}
			for _, value := range configList(root["inbounds"]) {
				tags[configString(configMap(value)["tag"])]++
			}
			for _, value := range configList(root["inbounds"]) {
				in := configMap(value)
				tag := configString(in["tag"])
				node := SubscriptionSourceNode{Tag: tag, Type: configString(in["type"]), Port: configInt(in["listen_port"]), ServerName: subscriptionServerName(in, root, source.Address), Issue: subscriptionProtocolIssue(in)}
				if tag == "" {
					node.Issue = "missing_tag"
				} else if tags[tag] > 1 {
					node.Issue = "duplicate_tag"
				}
				source.Nodes = append(source.Nodes, node)
			}
		}
		visit(source, root)
	}
}

func (s *Store) SubscriptionSources() []SubscriptionSource {
	result := []SubscriptionSource{}
	s.visitSubscriptionSources(nil, func(source SubscriptionSource, _ configObject) { result = append(result, source) })
	return result
}

func subscriptionNodeKey(node SubscriptionNode) string { return node.ServerID + "\x00" + node.Tag }

func (s *Store) GenerateSubscription(profile Subscription, library Library) SubscriptionResult {
	result := SubscriptionResult{Issues: []SubscriptionIssue{}}
	var user ProtocolUser
	for _, value := range library.Users {
		if value.ID == profile.UserID {
			user = value
			break
		}
	}
	if user.ID == "" && (profile.Direct == nil || len(profile.Nodes) > 0) {
		result.Error = "user_required"
		return result
	}
	baseContent, configError := subscriptionConfiguration(profile)
	if configError != nil {
		result.Error, result.Reference = configError.Code, configError.Reference
		return result
	}
	base, _, _, err := subscriptionBase(baseContent)
	if err != nil {
		result.Error = "invalid_base"
		return result
	}
	selectedServers, selectedNodes := map[string]bool{}, map[string]bool{}
	for _, id := range profile.Servers {
		selectedServers[id] = true
	}
	for _, node := range profile.Nodes {
		selectedNodes[subscriptionNodeKey(node)] = true
	}
	if profile.Direct == nil && ((profile.Scope == "servers" && len(selectedServers) == 0) || (profile.Scope == "nodes" && len(selectedNodes) == 0)) {
		result.Error = "selection_required"
		return result
	}
	endpoints := map[string]SubscriptionEndpoint{}
	for _, endpoint := range profile.Endpoints {
		endpoints[subscriptionNodeKey(endpoint.SubscriptionNode)] = endpoint
	}
	type candidate struct {
		key, tag string
		out      configObject
		custom   bool
	}
	proxies := []candidate{}
	proxyBytes := 0
	labels := map[string]int{}
	var only map[string]bool
	if profile.Scope != "all" {
		only = map[string]bool{}
		for id := range selectedServers {
			if profile.Scope == "servers" {
				only[id] = true
			}
		}
		for _, node := range profile.Nodes {
			if profile.Scope == "nodes" {
				only[node.ServerID] = true
			}
		}
	}
	s.visitSubscriptionSources(only, func(source SubscriptionSource, root configObject) {
		if result.Error != "" {
			return
		}
		chosen := profile.Scope == "all" || profile.Scope == "servers" && selectedServers[source.ID]
		if profile.Scope == "servers" {
			delete(selectedServers, source.ID)
		}
		if profile.Scope == "nodes" {
			for _, node := range profile.Nodes {
				chosen = chosen || node.ServerID == source.ID
			}
		}
		if !chosen {
			return
		}
		if source.Issue != "" {
			result.Issues = append(result.Issues, SubscriptionIssue{Server: source.Name, Code: source.Issue})
			if profile.Scope != "all" {
				result.Error = "selection_unavailable"
			}
			return
		}
		for index, node := range source.Nodes {
			key := subscriptionNodeKey(SubscriptionNode{ServerID: source.ID, Tag: node.Tag})
			if profile.Scope == "nodes" && !selectedNodes[key] {
				continue
			}
			if profile.Scope == "nodes" {
				delete(selectedNodes, key)
			}
			issue := node.Issue
			in := configMap(configList(root["inbounds"])[index])
			address, port, name := source.Address, node.Port, node.ServerName
			if override, exists := endpoints[key]; exists {
				if override.Address != "" {
					address = override.Address
				}
				if override.Port != 0 {
					port = override.Port
				}
				if override.ServerName != "" {
					name = override.ServerName
				}
			}
			var out configObject
			if issue == "" && (!validClientAddress(address) || port < 1 || port > 65535) {
				issue = "endpoint_required"
			}
			if issue == "" {
				auth := subscriptionAuth(in, user)
				if auth == nil {
					issue = "user_not_on_node"
				} else {
					out, issue = subscriptionOutbound(in, root, auth, address, port, name)
				}
			}
			if issue != "" {
				if len(result.Issues) < 4096 {
					result.Issues = append(result.Issues, SubscriptionIssue{Server: source.Name, Node: node.Tag, Code: issue})
				}
				continue
			}
			if len(proxies) >= 4096 {
				result.Error = "too_many_nodes"
				return
			}
			encoded, err := json.Marshal(out)
			proxyBytes += len(encoded)
			if err != nil || proxyBytes > agent.MaxConfigBytes {
				result.Error = "config_too_large"
				return
			}
			tag := source.Name + " · " + node.Tag
			custom := strings.TrimSpace(endpoints[key].Name)
			if custom != "" {
				tag = custom
			}
			labels[tag]++
			proxies = append(proxies, candidate{key: key, tag: tag, out: out, custom: custom != ""})
		}
	})
	if result.Error != "" {
		return result
	}
	if profile.Scope == "servers" && len(selectedServers) != 0 || profile.Scope == "nodes" && len(selectedNodes) != 0 {
		result.Error = "selection_missing"
	}
	if result.Error != "" {
		return result
	}
	if len(proxies) == 0 && (profile.Direct == nil || len(profile.Nodes) > 0 || !profile.Direct.Enabled) {
		result.Error = "no_nodes"
		return result
	}
	known := map[string]bool{}
	for _, value := range configList(base["endpoints"]) {
		if tag := configString(configMap(value)["tag"]); tag != "" {
			known[tag] = true
		}
	}
	urltests, directs := []string{}, []string{}
	for _, group := range profile.Groups {
		if known[group.Tag] {
			result.Error, result.Reference = "tag_conflict", group.Tag
			return result
		}
		known[group.Tag] = true
		if group.Type == "urltest" {
			urltests = append(urltests, group.Tag)
		}
		if group.Type == "direct" {
			directs = append(directs, group.Tag)
		}
	}
	if profile.Direct != nil && profile.Direct.Enabled {
		if known[profile.Direct.Tag] {
			result.Error, result.Reference = "duplicate_outbound_name", profile.Direct.Tag
			return result
		}
		known[profile.Direct.Tag] = true
	}
	for _, proxy := range proxies {
		if proxy.custom && (labels[proxy.tag] > 1 || known[proxy.tag]) {
			result.Error, result.Reference = "duplicate_outbound_name", proxy.tag
			return result
		}
	}
	nodeTags := []string{}
	nodeNames, nodeOrder := map[string]string{}, []string{}
	for _, proxy := range proxies {
		tag := proxy.tag
		if labels[tag] > 1 || known[tag] {
			hash := sha256.Sum256([]byte(proxy.key))
			tag += " [" + hex.EncodeToString(hash[:4]) + "]"
		}
		for known[tag] {
			tag += "_"
		}
		known[tag] = true
		proxy.out["tag"] = tag
		nodeTags = append(nodeTags, tag)
		nodeNames[proxy.key] = tag
		nodeOrder = append(nodeOrder, proxy.key)
	}
	outbounds := []configObject{}
	outputBytes := len(baseContent)
	appendOutbound := func(out configObject) bool {
		encoded, err := json.MarshalIndent(out, "  ", "  ")
		outputBytes += len(encoded) + 6
		if err != nil || outputBytes > agent.MaxConfigBytes {
			result.Error = "config_too_large"
			return false
		}
		outbounds = append(outbounds, out)
		return true
	}
	if profile.Direct != nil {
		groups, groupError := subscriptionGroupOutbounds(profile, nodeNames, nodeOrder)
		if groupError != nil {
			result.Error, result.Reference = groupError.Code, groupError.Reference
			return result
		}
		for _, group := range groups {
			if !appendOutbound(group) {
				return result
			}
		}
	} else {
		for _, group := range profile.Groups {
			out := configObject{"type": group.Type, "tag": group.Tag}
			switch group.Type {
			case "selector":
				members := append(append(append([]string{}, urltests...), directs...), nodeTags...)
				out["outbounds"] = members
				if len(urltests) == 0 && len(directs) > 0 {
					out["default"] = nodeTags[0]
				}
			case "urltest":
				out["outbounds"] = nodeTags
			}
			if !appendOutbound(out) {
				return result
			}
		}
	}
	for _, proxy := range proxies {
		if !appendOutbound(proxy.out) {
			return result
		}
	}
	if missing := subscriptionMissingReferences(base, known); len(missing) != 0 {
		result.Error, result.Reference = "missing_outbound", strings.Join(missing, ", ")
		return result
	}
	content, err := insertSubscriptionOutbounds(baseContent, outbounds)
	if err != nil || len(content) > agent.MaxConfigBytes {
		result.Error = "config_too_large"
		return result
	}
	result.Content, result.Count = content, len(proxies)
	return result
}

// CleanJSONC preserves byte offsets, so only outbounds changes in the original text.
func subscriptionBase(content string) (configObject, int, int, error) {
	clean := agent.CleanJSONC([]byte(content))
	var root configObject
	if json.Unmarshal(clean, &root) != nil || root == nil {
		return nil, 0, 0, errors.New("base configuration must be an object")
	}
	decoder := json.NewDecoder(bytes.NewReader(clean))
	_, _ = decoder.Token()
	seen, start, end := map[string]bool{}, -1, -1
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil || seen[key.(string)] {
			return nil, 0, 0, errors.New("duplicate configuration field")
		}
		seen[key.(string)] = true
		position := int(decoder.InputOffset())
		for position < len(clean) && (clean[position] == ':' || bytes.ContainsRune([]byte(" \t\n\r"), rune(clean[position]))) {
			position++
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, 0, 0, err
		}
		if key == "outbounds" {
			start, end = position, int(decoder.InputOffset())
		}
	}
	return root, start, end, nil
}

func insertSubscriptionOutbounds(content string, outbounds []configObject) (string, error) {
	root, start, end, err := subscriptionBase(content)
	if err != nil {
		return "", err
	}
	encoded, err := json.MarshalIndent(outbounds, "  ", "  ")
	if err != nil {
		return "", err
	}
	if start >= 0 {
		return content[:start] + string(encoded) + content[end:], nil
	}
	open := bytes.IndexByte(agent.CleanJSONC([]byte(content)), '{') + 1
	separator := "\n"
	if len(root) != 0 {
		separator = ",\n"
	}
	return content[:open] + "\n  \"outbounds\": " + string(encoded) + separator + content[open:], nil
}

func subscriptionMissingReferences(root configObject, known map[string]bool) []string {
	missing := map[string]bool{}
	check := func(value any) {
		if tag := configString(value); tag != "" && !known[tag] {
			missing[tag] = true
		}
	}
	var walk func(any, bool)
	walk = func(value any, route bool) {
		switch node := value.(type) {
		case map[string]any:
			for key, item := range node {
				if key == "detour" || key == "download_detour" || route && key == "outbound" {
					check(item)
				}
				walk(item, route)
			}
		case []any:
			for _, item := range node {
				walk(item, route)
			}
		}
	}
	check(configMap(root["route"])["final"])
	walk(root["route"], true)
	for key, value := range root {
		if key != "route" && key != "inbounds" {
			walk(value, false)
		}
	}
	result := make([]string, 0, len(missing))
	for tag := range missing {
		result = append(result, tag)
	}
	sort.Strings(result)
	return result
}
