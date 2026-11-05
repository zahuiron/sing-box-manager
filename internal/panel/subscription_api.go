package panel

import (
	"crypto/subtle"
	"errors"
	"net/http"
)

func (s *Server) subscriptionRequest(w http.ResponseWriter) bool {
	select {
	case s.subscriptions <- struct{}{}:
		return true
	default:
		failure(w, http.StatusTooManyRequests, "busy", "subscription generation is busy")
		return false
	}
}

func (s *Server) subscriptionSources(w http.ResponseWriter, r *http.Request) {
	if !s.subscriptionRequest(w) {
		return
	}
	defer func() { <-s.subscriptions }()
	respond(w, 200, s.store.SubscriptionSources())
}

func (s *Server) previewSubscription(w http.ResponseWriter, r *http.Request) {
	if !s.subscriptionRequest(w) {
		return
	}
	defer func() { <-s.subscriptions }()
	var input Subscription
	if !decode(w, r, &input, 4<<20) {
		return
	}
	if err := validateSubscription(input); err != nil {
		var configError *subscriptionConfigError
		if errors.As(err, &configError) {
			respond(w, 200, SubscriptionResult{Error: configError.Code, Reference: configError.Reference, Issues: []SubscriptionIssue{}})
		} else {
			failure(w, 400, "invalid_subscription", err.Error())
		}
		return
	}
	library, err := s.store.Library()
	if err != nil {
		failure(w, 500, "library_unavailable", "cannot read the subscription library")
		return
	}
	respond(w, 200, s.store.GenerateSubscription(input, library))
}

func (s *Server) downloadSubscription(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	if len(r.PathValue("token")) != 52 || len(r.PathValue("id")) > 80 {
		http.NotFound(w, r)
		return
	}
	if !s.subscriptionRequest(w) {
		return
	}
	defer func() { <-s.subscriptions }()
	library, err := s.store.Library()
	if err != nil {
		http.Error(w, "subscription unavailable", http.StatusServiceUnavailable)
		return
	}
	for _, profile := range library.Subscriptions {
		if profile.ID != r.PathValue("id") || profile.Token == "" || subtle.ConstantTimeCompare([]byte(profile.Token), []byte(r.PathValue("token"))) != 1 {
			continue
		}
		result := s.store.GenerateSubscription(profile, library)
		if result.Error != "" {
			http.Error(w, "subscription unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Disposition", "attachment; filename=\"config.json\"")
		if r.Method != http.MethodHead {
			_, _ = w.Write([]byte(result.Content))
		}
		return
	}
	http.NotFound(w, r)
}
