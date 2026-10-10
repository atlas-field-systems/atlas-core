# The Core image carries one static Core binary and nothing else, so loading
# it needs no network access and it makes no outbound calls.
FROM scratch
COPY atlas-core /atlas-core
ENTRYPOINT ["/atlas-core"]
