package panel

import (
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"net"
	"strings"
)

type configObject = map[string]any

func configMap(value any) configObject {
	result, _ := value.(map[string]any)
	return result
}

func configList(value any) []any {
	result, _ := value.([]any)
	return result
}

func configString(value any) string {
	result, _ := value.(string)
	return result
}

func configInt(value any) int {
	result, _ := value.(float64)
	return int(result)
}

func configBool(value any) bool {
	result, _ := value.(bool)
	return result
}

func copyConfigFields(target, source configObject, fields ...string) {
	for _, field := range fields {
		if value, ok := source[field]; ok {
			target[field] = value
		}
	}
}

func subscriptionProtocolIssue(in configObject) string {
	switch configString(in["type"]) {
	case "anytls", "http", "mixed", "naive", "socks", "hysteria", "hysteria2", "shadowsocks", "trojan", "tuic", "vless", "vmess", "snell":
	default:
		return "unsupported_protocol"
	}
	if configString(in["detour"]) != "" || len(configList(in["destinations"])) != 0 || configBool(in["managed"]) || len(configMap(in["realm"])) > 0 {
		return "unsupported_chain"
	}
	if configString(in["type"]) == "snell" && configInt(in["version"]) != 6 {
		return "unsupported_protocol"
	}
	tls := configMap(in["tls"])
	if strings.HasPrefix(configString(tls["client_authentication"]), "require") {
		return "client_certificate_required"
	}
	if configBool(configMap(tls["ech"])["enabled"]) {
		return "ech_unsupported"
	}
	return ""
}

func firstConfigString(value any) string {
	if text := configString(value); text != "" {
		return text
	}
	for _, item := range configList(value) {
		if text := configString(item); text != "" {
			return text
		}
	}
	return ""
}

func subscriptionServerName(in, root configObject, address string) string {
	tls := configMap(in["tls"])
	if name := configString(tls["server_name"]); name != "" {
		return name
	}
	if name := configString(configMap(configMap(tls["reality"])["handshake"])["server"]); name != "" {
		return name
	}
	provider := configMap(tls["certificate_provider"])
	if tag := configString(tls["certificate_provider"]); tag != "" {
		for _, value := range configList(root["certificate_providers"]) {
			candidate := configMap(value)
			if configString(candidate["tag"]) == tag {
				provider = candidate
				break
			}
		}
	}
	if provider == nil {
		provider = configMap(tls["acme"])
	}
	domains := configList(provider["domain"])
	if domain := configString(provider["domain"]); domain != "" {
		domains = []any{domain}
	}
	for _, value := range domains {
		name := configString(value)
		if strings.EqualFold(name, address) || (strings.HasPrefix(name, "*.") && strings.HasSuffix(address, name[1:])) {
			return address
		}
	}
	for _, value := range domains {
		if name := configString(value); name != "" && !strings.Contains(name, "*") {
			return name
		}
	}
	if net.ParseIP(address) == nil {
		return address
	}
	return ""
}

// Match protocol identity first; unnamed legacy entries require unique matching credentials.
func subscriptionAuth(in configObject, user ProtocolUser) configObject {
	protocol := configString(in["type"])
	var credential configObject
	for _, item := range user.Protocols {
		if item.Type == protocol {
			_ = json.Unmarshal(item.Auth, &credential)
			break
		}
	}
	if credential == nil {
		return nil
	}
	identity := "name"
	if protocol == "http" || protocol == "mixed" || protocol == "naive" || protocol == "socks" {
		identity = "username"
	}
	entries := configList(in["users"])
	if len(entries) == 0 && protocol == "shadowsocks" {
		if password := configString(credential["password"]); password != "" && password == configString(in["password"]) {
			return configObject{"password": password}
		}
		return nil
	}
	name := configString(credential[identity])
	var match configObject
	for _, value := range entries {
		entry := configMap(value)
		if name != "" && configString(entry[identity]) == name {
			if match != nil {
				return nil
			}
			match = entry
		}
	}
	if match != nil {
		return match
	}
	for _, value := range entries {
		entry := configMap(value)
		if configString(entry[identity]) != "" {
			continue
		}
		equal, count := true, 0
		for _, key := range []string{"uuid", "password", "auth", "auth_str", "userkey"} {
			if v, exists := credential[key]; exists {
				encoded, _ := json.Marshal(v)
				other, _ := json.Marshal(entry[key])
				equal = equal && string(encoded) == string(other)
				count++
			}
		}
		if equal && count > 0 {
			if match != nil {
				return nil
			}
			match = entry
		}
	}
	return match
}

func subscriptionTLS(in, root configObject, address, name string) (configObject, string) {
	source := configMap(in["tls"])
	if !configBool(source["enabled"]) {
		return nil, ""
	}
	if name == "" {
		name = subscriptionServerName(in, root, address)
	}
	tls := configObject{"enabled": true}
	if name != "" {
		tls["server_name"] = name
	}
	copyConfigFields(tls, source, "alpn", "min_version", "max_version", "cipher_suites", "curve_preferences")
	if reality := configMap(source["reality"]); configBool(reality["enabled"]) {
		private, err := base64.RawURLEncoding.DecodeString(configString(reality["private_key"]))
		if err != nil {
			return nil, "invalid_reality"
		}
		key, err := ecdh.X25519().NewPrivateKey(private)
		if err != nil {
			return nil, "invalid_reality"
		}
		if name == "" {
			return nil, "tls_name_required"
		}
		tls["reality"] = configObject{"enabled": true, "public_key": base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), "short_id": firstConfigString(reality["short_id"])}
		tls["utls"] = configObject{"enabled": true, "fingerprint": "chrome"}
	}
	return tls, ""
}

func subscriptionOutbound(in, root configObject, auth configObject, address string, port int, name string) (configObject, string) {
	protocol := configString(in["type"])
	out := configObject{"type": protocol, "server": address, "server_port": port}
	required := []string{}
	switch protocol {
	case "anytls", "trojan", "hysteria2":
		copyConfigFields(out, auth, "password")
		required = []string{"password"}
		if protocol == "hysteria2" {
			copyConfigFields(out, in, "up_mbps", "down_mbps")
			if obfs := configMap(in["obfs"]); obfs != nil {
				out["obfs"] = configObject{}
				copyConfigFields(configMap(out["obfs"]), obfs, "type", "password", "min_packet_size", "max_packet_size")
			}
		}
	case "vless":
		copyConfigFields(out, auth, "uuid", "flow")
		required = []string{"uuid"}
	case "vmess":
		copyConfigFields(out, auth, "uuid")
		out["security"] = "auto"
		if alter, exists := auth["alterId"]; exists {
			out["alter_id"] = alter
		}
		required = []string{"uuid"}
	case "tuic":
		copyConfigFields(out, auth, "uuid", "password")
		copyConfigFields(out, in, "congestion_control", "heartbeat")
		required = []string{"uuid"}
	case "http", "mixed", "socks", "naive":
		copyConfigFields(out, auth, "username", "password")
		required = []string{"username"}
		if protocol == "mixed" || protocol == "socks" {
			out["type"], out["version"] = "socks", "5"
		}
		if protocol == "naive" && configString(in["network"]) == "udp" {
			out["quic"] = true
		}
	case "shadowsocks":
		copyConfigFields(out, in, "method", "network")
		copyConfigFields(out, auth, "password")
		if strings.HasPrefix(configString(in["method"]), "2022-blake3-aes-") && len(configList(in["users"])) > 0 {
			if configString(in["password"]) == "" {
				return nil, "missing_auth"
			}
			out["password"] = configString(in["password"]) + ":" + configString(auth["password"])
		}
		required = []string{"method", "password"}
	case "snell":
		copyConfigFields(out, in, "version", "psk", "mode")
		copyConfigFields(out, auth, "userkey")
		required = []string{"psk", "userkey"}
	case "hysteria":
		copyConfigFields(out, auth, "auth", "auth_str")
		copyConfigFields(out, in, "up", "up_mbps", "down", "down_mbps", "obfs")
		if auth["auth"] == nil && configString(auth["auth_str"]) == "" {
			return nil, "missing_auth"
		}
		if configString(out["up"]) == "" && configInt(out["up_mbps"]) <= 0 || configString(out["down"]) == "" && configInt(out["down_mbps"]) <= 0 {
			return nil, "bandwidth_required"
		}
	}
	for _, field := range required {
		if configString(out[field]) == "" {
			return nil, "missing_auth"
		}
	}
	tls, issue := subscriptionTLS(in, root, address, name)
	if issue != "" {
		return nil, issue
	}
	if tls != nil {
		out["tls"] = tls
	} else if protocol == "anytls" || protocol == "hysteria2" || protocol == "hysteria" || protocol == "tuic" || protocol == "naive" {
		return nil, "tls_required"
	}
	if protocol == "vless" || protocol == "vmess" || protocol == "trojan" {
		if transport := configMap(in["transport"]); transport != nil {
			client := configObject{}
			switch configString(transport["type"]) {
			case "http", "ws", "grpc", "httpupgrade", "quic":
				copyConfigFields(client, transport, "type", "host", "path", "method", "headers", "service_name", "max_early_data", "early_data_header_name")
			default:
				return nil, "unsupported_transport"
			}
			out["transport"] = client
		}
	}
	return out, ""
}
