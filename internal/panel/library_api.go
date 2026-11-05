package panel

import (
	"errors"
	"net/http"
)

func (s *Server) readLibrary(w http.ResponseWriter, r *http.Request) {
	data, err := s.store.Library()
	if err != nil {
		failure(w, 500, "library_unavailable", "cannot read the user and template library")
		return
	}
	respond(w, 200, data)
}

func (s *Server) saveLibrary(w http.ResponseWriter, r *http.Request) {
	var input Library
	if !decode(w, r, &input, 16<<20) {
		return
	}
	data, err := s.store.SaveLibrary(input)
	if err != nil {
		if errors.Is(err, errLibraryConflict) {
			failure(w, 409, "library_conflict", err.Error())
		} else if errors.Is(err, errInvalidLibrary) {
			failure(w, 400, "invalid_library", err.Error())
		} else {
			failure(w, 500, "library_save_failed", "cannot save the user and template library")
		}
		return
	}
	respond(w, 200, data)
}
