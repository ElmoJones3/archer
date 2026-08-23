# Use hierarchical Merkle directory trees

Archer will represent an immutable tree as a canonical hierarchy of directory
nodes rooted at a `TreeRef`. Each directory directly names its sorted file and
directory children, while file content remains independently addressed by a
`BlobRef`. Public construction may accept flat logical paths, but those paths
compile into the same hierarchy. This permits structural sharing, incremental
publication, partial traversal, and comparison that skips equal subtrees.

## Considered options

A single flat manifest of full paths would be easy to inspect, but every change
would replace and reprocess the complete manifest. It would also discard the
useful directory-level identity proven by Git trees and remote-execution Merkle
trees.

Git and Bazel Remote Execution influenced the hierarchy, but neither product's
wire format defines Archer's tree identity.

## Consequences

Directories are derived from contained file paths, so empty directories have no
canonical identity in v1. Changing one file replaces its `BlobRef` and the
directory nodes along the path to the root while unrelated subtrees retain their
identities. Tree stores and conformance suites must preserve and verify that
recursive relationship.
