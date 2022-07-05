// @nolint
import Link from 'next/link';
import React, {useEffect} from 'react';

export default function UnboundObject() {
  const bigArray = Array(1024 * 1024 * 2).fill(0);

  const eventHandler = () => {
    console.log('Does something with with hugeObject', bigArray);
  };

  useEffect(() => {
    window.addEventListener('custom-click', eventHandler);
  }, []);

  return (
    <div className="container">
      <div className="row">
        <Link href="/">Go back</Link>
      </div>
      <br />
      <div className="row">
        Object<code>bigArray</code>is leaked. Please check <code>Memory</code>{' '}
        tab in devtools
      </div>
    </div>
  );
}
