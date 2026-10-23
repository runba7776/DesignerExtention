import { useState } from 'react';
import { Icon } from '../ui';

const ratingLabels = ['改善が必要', 'やや使いにくい', 'ふつう', '良い', 'とても良い'];
const feedbackReasons = ['見やすさ', '説明の分かりやすさ', '内容の正確さ', '情報量', '配色・雰囲気'];

/** A rating of the chosen draft (1-5 stars and what it was about). Only the numbers and the chosen reasons are
 * kept on this PC; give the component a new key for another draft. */
export function FeedbackSection({
  title,
  busy,
  onSubmit,
}: {
  title: string;
  busy: boolean;
  /** Saves the rating; calls saved() when it was stored. */
  onSubmit: (rating: number, reasons: string[], saved: () => void) => void;
}) {
  const [rating, setRating] = useState(0);
  const [reasons, setReasons] = useState<string[]>([]);
  const [stored, setStored] = useState(false);
  const toggle = (reason: string) =>
    setReasons(previous =>
      previous.includes(reason) ? previous.filter(item => item !== reason) : [...previous, reason],
    );
  return (
    <section className="feedback" aria-label="評価">
      <h3>{title}</h3>
      {stored ? (
        <p className="success-note">
          <Icon name="check" size={15} />
          評価をこの PC に保存しました。ありがとうございます。
        </p>
      ) : (
        <>
          <div className="feedback-row" role="group" aria-label="5段階で評価">
            {[1, 2, 3, 4, 5].map(value => (
              <button
                className={`rating-button ${rating >= value ? 'chosen' : ''}`}
                key={value}
                onClick={() => setRating(value)}
                aria-label={`${value}点：${ratingLabels[value - 1]}`}
                aria-pressed={rating === value}
              >
                <Icon name="star" size={22} />
              </button>
            ))}
            <span className="rating-name">
              {rating ? ratingLabels[rating - 1] : '良かった点や、改善したい点を教えてください'}
            </span>
          </div>
          {rating > 0 && (
            <>
              <div className="feedback-reasons">
                {feedbackReasons.map(reason => (
                  <button
                    key={reason}
                    type="button"
                    className={reasons.includes(reason) ? 'active' : ''}
                    aria-pressed={reasons.includes(reason)}
                    onClick={() => toggle(reason)}
                  >
                    {reason}
                  </button>
                ))}
              </div>
              <div className="feedback-submit">
                <button
                  className="button secondary small"
                  onClick={() => onSubmit(rating, reasons, () => setStored(true))}
                  disabled={busy}
                >
                  評価を保存
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
