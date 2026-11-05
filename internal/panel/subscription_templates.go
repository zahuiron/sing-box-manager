package panel

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"

	"github.com/zahuiron/sing-box-manager/internal/agent"
)

type subscriptionConfigError struct {
	Code      string
	Reference string
}

func (e *subscriptionConfigError) Error() string {
	if e.Reference == "" {
		return e.Code
	}
	return e.Code + ": " + e.Reference
}

func subscriptionConfiguration(profile Subscription) (string, *subscriptionConfigError) {
	if len(profile.Templates) == 0 {
		if strings.TrimSpace(profile.Content) == "" {
			return "", &subscriptionConfigError{Code: "templates_required"}
		}
		if len(profile.Content) > agent.MaxConfigBytes {
			return "", &subscriptionConfigError{Code: "config_too_large"}
		}
		root, _, _, err := subscriptionBase(profile.Content)
		if err != nil {
			return "", &subscriptionConfigError{Code: "invalid_base"}
		}
		if !subscriptionEmptyOutbounds(root) {
			return "", &subscriptionConfigError{Code: "template_outbounds"}
		}
		return profile.Content, nil
	}
	if len(profile.Templates) > 256 {
		return "", &subscriptionConfigError{Code: "too_many_templates"}
	}
	root, ids, size := configObject{}, map[string]bool{}, 0
	for _, template := range profile.Templates {
		if template.Target != "client" {
			return "", &subscriptionConfigError{Code: "client_template_required", Reference: template.Name}
		}
		if template.ID == "" || len(template.ID) > 80 || ids[template.ID] || template.Name == "" || len(template.Name) > 128 {
			return "", &subscriptionConfigError{Code: "invalid_template", Reference: template.Name}
		}
		ids[template.ID] = true
		size += len(template.Content)
		if size > agent.MaxConfigBytes {
			return "", &subscriptionConfigError{Code: "config_too_large"}
		}
		value, _, _, err := subscriptionBase(template.Content)
		if err != nil {
			return "", &subscriptionConfigError{Code: "invalid_template", Reference: template.Name}
		}
		var fragment configObject
		switch template.Kind {
		case "config":
			if !subscriptionEmptyOutbounds(value) {
				return "", &subscriptionConfigError{Code: "template_outbounds", Reference: template.Name}
			}
			if len(profile.Templates) == 1 {
				return template.Content, nil
			}
			delete(value, "outbounds")
			fragment = value
		case "outbounds":
			return "", &subscriptionConfigError{Code: "template_outbounds", Reference: template.Name}
		case "inbounds", "endpoints", "services", "certificate_providers", "http_clients", "network_namespaces":
			fragment = configObject{template.Kind: []any{value}}
		case "log", "dns", "ntp", "certificate", "route", "experimental":
			fragment = configObject{template.Kind: value}
		default:
			return "", &subscriptionConfigError{Code: "invalid_template_kind", Reference: template.Name + " · " + template.Kind}
		}
		if path := mergeSubscriptionConfig(root, fragment, ""); path != "" {
			return "", &subscriptionConfigError{Code: "template_conflict", Reference: template.Name + " · " + path}
		}
	}
	encoded, err := json.MarshalIndent(root, "", "  ")
	if err != nil || len(encoded) > agent.MaxConfigBytes {
		return "", &subscriptionConfigError{Code: "config_too_large"}
	}
	return string(encoded) + "\n", nil
}

func subscriptionEmptyOutbounds(root configObject) bool {
	value := root["outbounds"]
	if value == nil {
		return true
	}
	list, ok := value.([]any)
	return ok && len(list) == 0
}

func mergeSubscriptionConfig(target, source configObject, parent string) string {
	keys := make([]string, 0, len(source))
	for key := range source {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := source[key]
		previous, exists := target[key]
		if !exists {
			target[key] = value
			continue
		}
		path := parent + "/" + strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1")
		switch old := previous.(type) {
		case map[string]any:
			if next, ok := value.(map[string]any); ok {
				if conflict := mergeSubscriptionConfig(old, next, path); conflict != "" {
					return conflict
				}
				continue
			}
		case []any:
			if next, ok := value.([]any); ok {
				target[key] = append(old, next...)
				continue
			}
		}
		if !reflect.DeepEqual(previous, value) {
			return path
		}
	}
	return ""
}
