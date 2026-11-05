package agent

import (
	"os"
	"strings"
)

func detectEnvironment() string {
	if os.Getenv("SING_BOX_MANAGER_ENVIRONMENT") == "docker" {
		return "docker"
	}
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		data, err = os.ReadFile("/usr/lib/os-release")
	}
	if err != nil {
		return ""
	}
	var id, like string
	for line := range strings.SplitSeq(string(data), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		value = strings.ToLower(strings.Trim(value, `"'`))
		switch key {
		case "ID":
			id = value
		case "ID_LIKE":
			like = value
		}
	}
	for _, value := range append([]string{id}, strings.Fields(like)...) {
		if value == "debian" || value == "alpine" {
			return value
		}
	}
	return ""
}
