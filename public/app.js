const { useEffect, useState } = React;

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function App() {
  const [stories, setStories] = useState([]);
  const [hallOfFame, setHallOfFame] = useState([]);
  const [form, setForm] = useState({ author: '', text: '' });
  const [commentText, setCommentText] = useState({});

  const loadStories = async () => {
    const [storiesRes, hallRes] = await Promise.all([
      fetch('/api/stories'),
      fetch('/api/hall-of-fame')
    ]);
    const storiesData = await storiesRes.json();
    const hallData = await hallRes.json();
    setStories(storiesData.stories || []);
    setHallOfFame(hallData.hallOfFame || []);
  };

  useEffect(() => {
    loadStories();
  }, []);

  const postStory = async (e) => {
    e.preventDefault();
    const res = await fetch('/api/stories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    });
    if (res.ok) {
      setForm({ author: '', text: '' });
      loadStories();
    } else {
      alert('Please write a real story with at least 40 characters.');
    }
  };

  const likeStory = async (id) => {
    await fetch(`/api/stories/${id}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    loadStories();
  };

  const shareStory = async (story) => {
    await fetch(`/api/stories/${story.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const shareText = `Made My Day story: ${story.text}`;
    if (navigator.share) {
      navigator.share({ title: 'Made My Day', text: shareText, url: window.location.href }).catch(() => null);
    } else {
      navigator.clipboard.writeText(shareText);
      alert('Copied to clipboard.');
    }
    loadStories();
  };

  const addComment = async (storyId) => {
    const text = (commentText[storyId] || '').trim();
    if (text.length < 2) return;
    await fetch(`/api/stories/${storyId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    setCommentText((c) => ({ ...c, [storyId]: '' }));
    loadStories();
  };

  return (
    <div className="container">
      <section className="hero">
        <h1>Made My Day 💛</h1>
        <p>Anonymous, same-day positive stories. No account needed. Share what made your day better.</p>
      </section>

      <section className="card" style={{ marginTop: 16, border: '2px solid #ffd45b' }}>
        <h3 style={{ marginTop: 0 }}>🏆 Hall of Fame Winner</h3>
        {hallOfFame[0] ? (
          <div>
            <div className="meta">Week of {hallOfFame[0].weekKey} · Prize: {hallOfFame[0].prize}</div>
            <div className="text" style={{ whiteSpace: 'pre-wrap' }}>{hallOfFame[0].text}</div>
            <div className="meta">Combined score: {hallOfFame[0].score} (likes + shares + comments)</div>
          </div>
        ) : (
          <p style={{ margin: 0 }}>First winner appears Monday at 6:00 AM after Sunday-night scoring.</p>
        )}
      </section>

      <section className="grid">
        <div className="card">
          <h3>Post your story</h3>
          <form onSubmit={postStory}>
            <label>Name (optional)</label>
            <input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} placeholder="Anonymous" />
            <label style={{ marginTop: 10, display: 'block' }}>What happened today?</label>
            <textarea value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Tell the full real-life story from today — what happened, who was involved, and why it made your day." />
            <button className="btn" style={{ marginTop: 10 }}>Post</button>
          </form>
          <p style={{ fontSize: 12, opacity: 0.75, marginTop: 10 }}>
            Auto-curation enabled: 5 real positive public stories imported each hour at random times.
          </p>
        </div>

        <div>
          {stories.map((story) => (
            <div className="card story" key={story.id}>
              <div className="meta">
                {story.author || 'Anonymous'} · {formatDate(story.createdAt)}
                {story.autoImported && <span className="badge">Auto</span>}
              </div>
              <div className="text">{story.text}</div>
              {story.sourceUrl && (
                <div style={{ marginBottom: 8 }}>
                  <a href={story.sourceUrl} target="_blank" rel="noreferrer">Source</a>
                </div>
              )}
              <div className="actions">
                <button className="pill" onClick={() => likeStory(story.id)}>❤️ {story.likes}</button>
                <button className="pill" onClick={() => shareStory(story)}>🔁 {story.shares}</button>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 600 }}>Comments ({story.commentCount || 0})</div>
                {(story.comments || []).map((comment) => (
                  <div key={comment.id} className="comment">{comment.text}</div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <input
                    placeholder="Write a comment"
                    value={commentText[story.id] || ''}
                    onChange={(e) => setCommentText((c) => ({ ...c, [story.id]: e.target.value }))}
                  />
                  <button className="pill" onClick={() => addComment(story.id)}>Post</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
